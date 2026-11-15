import { capture } from "@latitude-data/telemetry";
import { END, START, StateGraph } from "@langchain/langgraph";
import { latitude } from "../telemetry.js";
import type { AgentRunRequest, AgentStreamEvent } from "../types.js";
import { execute } from "./execute.js";
import { accept, answer, chart, finalize, suggestions } from "./finish.js";
import { RunLogger } from "./logger.js";
import { cache, generate } from "./plan.js";
import { route } from "./route.js";
import { AgentState, type NodeConfig, RunContextSchema, type State } from "./state.js";
import { checkValues } from "./values.js";
import { verify } from "./verify.js";

/** Logs, times and traces one node. */
function instrumented<T>(name: string, node: (state: State, config: NodeConfig) => Promise<T>) {
  return async (state: State, config: NodeConfig): Promise<T> => {
    const logger = config.context!.logger;
    const started = Date.now();
    logger.logLayerStarted(name);
    try {
      const result = await node(state, config);
      logger.logLayerCompleted(name, Date.now() - started);
      return result;
    } catch (error) {
      logger.logLayerError(name, error, Date.now() - started);
      throw error;
    }
  };
}

/**
 *   route ─┬─ small talk ─────────────────────────────────────────► finalize
 *          ├─ "chart that" ───────────────────────────────────────► accept
 *          └─ data ─► cache ─┬─ reuse SQL ─► execute
 *                            └─ generate ◄──┐
 *                                  │        │ repair, with what went wrong
 *                                  ▼        │
 *                              execute ─────┤ (database error, bad shape)
 *                                  │  └► checkValues (no rows) ─┤
 *                                  └──► verify ─────────────────┘
 *                                          ▼
 *        accept ─► writeAnswer ∥ planChart ∥ suggestFollowUps ─► finalize
 *
 * Built once at startup. Everything request-specific travels in the run's
 * context, so nothing here closes over a request.
 */
export const agentGraph = new StateGraph(AgentState, RunContextSchema)
  .addNode("route", instrumented("route", route), { ends: ["cache", "accept", "finalize"] })
  .addNode("cache", instrumented("cache", cache), { ends: ["generate", "execute", "finalize"] })
  .addNode("generate", instrumented("generate", generate), { ends: ["generate", "execute", "finalize"] })
  .addNode("execute", instrumented("execute", execute), {
    ends: ["execute", "generate", "checkValues", "verify", "accept", "finalize"],
  })
  .addNode("checkValues", instrumented("checkValues", checkValues), { ends: ["execute", "generate", "accept"] })
  .addNode("verify", instrumented("verify", verify), { ends: ["generate", "accept"] })
  .addNode("accept", instrumented("accept", accept))
  // Node names differ from state keys (answer, suggestions); LangGraph requires that.
  .addNode("writeAnswer", instrumented("writeAnswer", answer))
  .addNode("planChart", instrumented("planChart", chart))
  .addNode("suggestFollowUps", instrumented("suggestFollowUps", suggestions))
  .addNode("finalize", instrumented("finalize", finalize))
  .addEdge(START, "route")
  .addEdge("accept", "writeAnswer")
  .addEdge("accept", "planChart")
  .addEdge("accept", "suggestFollowUps")
  // Waits for all three before closing the message.
  .addEdge(["writeAnswer", "planChart", "suggestFollowUps"], "finalize")
  .addEdge("finalize", END)
  .compile({ name: "kakaw-agent" });

/** The deepest path (four drafts, each repaired and re-checked) stays well under this. */
const RECURSION_LIMIT = 60;

function failureEvent(request: AgentRunRequest, error: unknown): AgentStreamEvent {
  const message = error instanceof Error ? error.message.trim() || "Unexpected agent failure." : "Unexpected agent failure.";
  return {
    type: "message_failed",
    data: {
      messageId: request.messageId,
      error: message,
      errorInfo: { message, code: "AGENT_RUNTIME_ERROR", statusCode: 500, retryable: false },
    },
  };
}

async function* run(request: AgentRunRequest, logger: RunLogger, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent, Error | null> {
  const started = Date.now();
  logger.logRunStart();

  let final: State | null = null;
  try {
    const stream = await agentGraph.stream(
      {},
      { context: { request, logger }, streamMode: ["custom", "values"], recursionLimit: RECURSION_LIMIT, signal },
    );
    for await (const [mode, chunk] of stream as AsyncIterable<[string, unknown]>) {
      if (mode === "custom") {
        yield chunk as AgentStreamEvent;
      } else {
        final = chunk as State;
      }
    }
  } catch (error) {
    // The client went away; there is nobody to tell.
    if (signal?.aborted) {
      logger.logRunError("Cancelled by the client.", Date.now() - started);
      return error instanceof Error ? error : new Error(String(error));
    }
    const message = error instanceof Error ? error.message : String(error);
    logger.logRunError(message, Date.now() - started);
    yield failureEvent(request, error);
    return error instanceof Error ? error : new Error(message);
  }

  const failed = !final || !!final.errorMessage || !final.answer;
  logger.logRunEnd(failed ? "failed" : final!.clarification ? "clarification" : "answered", Date.now() - started);
  return failed ? new Error(final?.errorMessage ?? "Agent runtime did not produce an answer.") : null;
}

/**
 * Streams one turn as wire events. `message_started` goes out before any work
 * so the client can show the message immediately.
 *
 * With Latitude configured, the turn is one trace: every node and model call
 * runs inside the capture scope, and a failed turn is marked as an error.
 */
export async function* streamAgent(request: AgentRunRequest, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
  yield { type: "message_started", data: { messageId: request.messageId } };
  const logger = new RunLogger(request);

  if (!latitude) {
    yield* run(request, logger, signal);
    return;
  }

  const scope = capture.start("agent.turn", {
    userId: request.userId,
    sessionId: request.conversationId,
    tags: ["agent-run", request.llm.provider, request.database.provider],
    metadata: {
      requestId: request.requestId,
      messageId: request.messageId,
      model: request.llm.model,
      sourceId: request.database.sourceId,
      historyLength: request.history.length,
    },
  });
  try {
    const failure = yield* run(request, logger, signal);
    scope.end(failure ?? undefined);
  } catch (error) {
    scope.end(error);
    throw error;
  }
}
