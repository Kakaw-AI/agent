import { Command } from "@langchain/langgraph";
import { getSchemaIndex } from "../database/schema-index.js";
import { describeFieldResolution, resolveVisualizationRequestFields } from "../graph/field-resolution.js";
import { decideVisualizationCapability } from "../graph/visualization.js";
import { buildDirectAnswer } from "../llm/answers.js";
import { extractLastAnalyzableAnalyticalTurn, extractRowsFromHistory } from "../llm/intent/history.js";
import { isSmallTalk, VISUALIZATION_PATTERNS } from "../llm/intent/patterns.js";
import { buildVisualizationRequestFromQuestion } from "../llm/intent/visualization-request.js";
import { invokeStructured } from "../llm/invoke.js";
import { RouteSchema } from "../llm/schemas.js";
import { RoutePromptBuilder } from "../prompts/RoutePromptBuilder.js";
import type { TokenUsage } from "../types.js";
import { normalizeQuestion } from "../utils/text.js";
import { type NodeConfig, runtime, type State, type Update } from "./state.js";

/** "plot that", "chart it", "make it a pie chart": a chart request and little else. */
function isShortChartRequest(message: string): boolean {
  return message.split(/\s+/).length <= 6 && VISUALIZATION_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Decides what the turn is and which question it asks.
 *
 * A first message is taken as written; no model call. When there is history,
 * one small model call rewrites a follow-up into a standalone question and
 * spots "chart that" requests. That replaced regex intent rules which sent
 * "hi, how many orders..." to a canned greeting and only recognised a chart
 * follow-up of four words or fewer.
 */
export async function route(_state: State, config: NodeConfig) {
  const { request, step, hooks, signal } = runtime(config, "route");
  const message = request.message.trim();

  if (isSmallTalk(message)) {
    return new Command({
      goto: "finalize",
      update: {
        kind: "small_talk",
        question: message,
        answer: buildDirectAnswer(message),
        steps: [step("Responding directly without querying the database...")],
      } satisfies Update,
    });
  }

  let kind: State["kind"] = "data";
  let question = message;
  let tokenUsage: TokenUsage | null = null;
  const toolCalls: Array<Record<string, unknown>> = [];

  if (request.history.some((turn) => turn.role === "assistant")) {
    try {
      const result = await invokeStructured({
        llm: request.llm,
        ...new RoutePromptBuilder().build({ history: request.history, message }),
        temperature: 0,
        signal,
        ...hooks,
        schema: RouteSchema,
      });
      tokenUsage = result.tokenUsage;
      kind = result.value.kind;
      question = result.value.standaloneQuestion.trim() || message;
      toolCalls.push({ tool: "route", kind, standaloneQuestion: question });
    } catch (error) {
      // A failed rewrite should not fail the turn: answer the message as
      // written. A short "plot that" is still recognisable without the model,
      // and treating it as a fresh question only leads to "plot what?".
      if (isShortChartRequest(message)) {
        kind = "chart_previous";
      }
      toolCalls.push({ tool: "route", error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (kind === "small_talk") {
    return new Command({
      goto: "finalize",
      update: {
        kind,
        question: message,
        answer: buildDirectAnswer(message),
        tokenUsage,
        toolCalls,
        steps: [step("Responding directly without querying the database...")],
      } satisfies Update,
    });
  }

  const previous = extractRowsFromHistory(request.history);
  if (kind === "chart_previous" && !previous) {
    kind = "data";
  }

  const rewritten = normalizeQuestion(question) !== normalizeQuestion(message);
  const steps = [
    step(kind === "chart_previous" ? "Charting the previous result..." : "Classifying intent and visualization requirements..."),
  ];
  if (rewritten) {
    steps.push(step(`Reading this as: "${question}"`));
  }

  // Chart intent and fields still come from the deterministic parser; it feeds
  // the visualization checks that keep a requested dimension from being dropped.
  const wantsVisualization = kind === "chart_previous" || VISUALIZATION_PATTERNS.some((pattern) => pattern.test(question));
  const parsedRequest = wantsVisualization
    ? buildVisualizationRequestFromQuestion(question) ??
      extractLastAnalyzableAnalyticalTurn(request.history)?.visualizationRequest ??
      null
    : null;

  // The fields above came out of regexes over the question, so they are
  // whatever the user typed. Reconcile them with the catalog before anything
  // downstream compares them for equality.
  const resolution = resolveVisualizationRequestFields(
    parsedRequest,
    getSchemaIndex(request.knowledge, request.database.schemaFingerprint),
  );
  const visualizationRequest = resolution?.request ?? parsedRequest;
  const note = describeFieldResolution(resolution);
  if (note) steps.push(step(note));

  const update: Update = {
    kind,
    question,
    rewritten,
    wantsVisualization,
    visualizationRequest,
    visualizationCapabilityDecision: decideVisualizationCapability(visualizationRequest),
    tokenUsage,
    steps,
    toolCalls: resolution
      ? [
          ...toolCalls,
          {
            tool: "schema_resolution",
            corrections: resolution.corrections,
            unresolved: resolution.unresolved,
            didYouMean: resolution.didYouMean,
          },
        ]
      : toolCalls,
    ...(resolution
      ? {
          fieldResolutions: resolution.entries,
          schemaCorrections: resolution.corrections.map((correction) => ({ ...correction, stage: "intent" })),
        }
      : {}),
  };

  if (kind === "chart_previous" && previous) {
    return new Command({
      goto: "accept",
      update: {
        ...update,
        sql: previous.sql ?? "",
        rows: previous.rows,
        columns: previous.columns,
        rowCount: previous.rows.length,
      },
    });
  }

  return new Command({ goto: "cache", update });
}
