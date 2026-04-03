import { StateGraph } from "@langchain/langgraph";
import { GraphState } from "./state.js";
import {
  loadCacheNode,
  classifyIntentNode,
  generateSqlNode,
  executeSqlNode,
  composeAnswerNode,
  planChartNode,
  generateSuggestionsNode,
} from "./nodes.js";
import type { AgentRunRequest, AgentStreamEvent } from "../types.js";
import type { GraphStateValue } from "./state.js";

export async function runAgent(request: AgentRunRequest): Promise<AgentStreamEvent[]> {
  const graph = new StateGraph(GraphState)
    .addNode("loadCache", (state) => loadCacheNode(request, state))
    .addNode("classifyIntent", (state) => classifyIntentNode(request, state))
    .addNode("generateSql", (state) => generateSqlNode(request, state))
    .addNode("executeSql", (state) => executeSqlNode(request, state))
    .addNode("composeAnswer", (state) => composeAnswerNode(request, state))
    .addNode("planChart", (state) => planChartNode(request, state))
    .addNode("generateSuggestions", (state) => generateSuggestionsNode(request, state))
    .addEdge("__start__", "loadCache")
    .addEdge("loadCache", "classifyIntent")
    .addEdge("classifyIntent", "generateSql")
    .addEdge("generateSql", "executeSql")
    .addEdge("executeSql", "composeAnswer")
    .addEdge("composeAnswer", "planChart")
    .addEdge("planChart", "generateSuggestions")
    .addEdge("generateSuggestions", "__end__")
    .compile();

  const finalState = await graph.invoke({});

  return buildEventsFromFinalState(request, finalState);
}

export function buildEventsFromFinalState(
  request: AgentRunRequest,
  finalState: GraphStateValue,
): AgentStreamEvent[] {

  const events: AgentStreamEvent[] = [
    { type: "message_started", data: { messageId: request.messageId } },
    ...finalState.steps.map((step) => ({ type: "agent_step", data: { text: step.text } }) as const),
  ];

  if (finalState.sql) {
    events.push({ type: "sql_generated", data: { sql: finalState.sql } });
  }
  if (finalState.rows.length > 0 || finalState.columns.length > 0) {
    events.push({
      type: "sql_result",
      data: {
        rowCount: finalState.rowCount,
        columns: finalState.columns,
        rows: finalState.rows,
      },
    });
  }
  if (finalState.chartSpec) {
    events.push({
      type: "chart_generated",
      data: {
        chartType: String(finalState.chartSpec.kind ?? "chart"),
        title:
          typeof finalState.chartSpec.title === "string"
            ? finalState.chartSpec.title
            : undefined,
        spec: finalState.chartSpec,
      },
    });
  }

  if (finalState.errorMessage) {
    return [
      ...events,
      {
        type: "message_failed",
        data: {
          messageId: request.messageId,
          error: finalState.errorMessage,
          errorInfo: {
            message: finalState.errorMessage,
            code: "AGENT_SQL_GENERATION_FAILED",
            statusCode: 502,
            retryable: false,
          },
        },
      },
    ];
  }

  if (!finalState.answer) {
    return [
      ...events,
      {
        type: "message_failed",
        data: {
          messageId: request.messageId,
          error: "Agent runtime did not produce an answer.",
          errorInfo: {
            message: "Agent runtime did not produce an answer.",
            code: "AGENT_RUNTIME_ERROR",
            statusCode: 500,
            retryable: false,
          },
        },
      },
    ];
  }

  events.push({
    type: "message_completed",
    data: {
      messageId: request.messageId,
      content: finalState.answer,
      tokenUsage: finalState.tokenUsage ?? undefined,
    },
  });
  if (finalState.suggestions.length > 0) {
    events.push({
      type: "suggestions_generated",
      data: {
        messageId: request.messageId,
        suggestions: finalState.suggestions,
      },
    });
  }
  events.push({
    type: "agent_trace",
    data: {
      steps: finalState.steps,
      toolCalls: finalState.toolCalls,
      repairHistory: finalState.repairHistory,
      cacheKey: finalState.cacheKey,
      cacheHit: finalState.cacheHit,
      chartSpec: finalState.chartSpec ?? undefined,
    },
  });

  return events;
}
