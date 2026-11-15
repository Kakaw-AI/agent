import { ReducedValue, StateSchema, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";
import type { FieldResolutionEntry } from "../graph/types.js";
import type {
  AgentRunRequest,
  AgentStreamEvent,
  TokenUsage,
  VisualizationCapabilityDecision,
  VisualizationChartSpec,
  VisualizationRequest,
  VisualizationValidationStatus,
} from "../types.js";
import { mergeTokenUsage } from "../utils/token.js";
import type { RunLogger } from "./logger.js";

type Rows = Array<Record<string, unknown>>;

/** Last value wins. `z.custom` because these are internal shapes, not input. */
const value = <T>(fallback: () => T) => z.custom<T>().default(fallback as never);

const appended = <T>() =>
  new ReducedValue(z.custom<T[]>().default(() => []), {
    reducer: (left: T[], right: T[]) => left.concat(right),
  });

/**
 * What a failed attempt hands to the next SQL generation. Set by the execute,
 * values and verify steps; cleared once a new draft is written.
 */
export type SqlFeedback = {
  sql: string;
  issues: string[];
  /** Rendered driver error with nearest catalog names, for database errors. */
  dbErrorBlock?: string;
};

export const AgentState = new StateSchema({
  /** small_talk answers directly; chart_previous re-charts rows already in the conversation. */
  kind: value<"data" | "small_talk" | "chart_previous">(() => "data"),
  /**
   * The question the rest of the run answers. For a follow-up ("what about
   * 2025?") this is the rewritten, standalone form, which is also what the
   * plan cache and query memory are keyed on.
   */
  question: value<string>(() => ""),
  /** True when `question` was rewritten from the user's text. */
  rewritten: value<boolean>(() => false),

  wantsVisualization: value<boolean>(() => false),
  visualizationRequest: value<VisualizationRequest | null>(() => null),
  visualizationCapabilityDecision: value<VisualizationCapabilityDecision | null>(() => null),
  fieldResolutions: value<FieldResolutionEntry[]>(() => []),

  cacheKey: value<string>(() => ""),
  /** Strict plan-cache hit: the whole previous answer is reused. */
  cacheHit: value<boolean>(() => false),
  /** SQL came from the plan cache or query memory; generation is skipped. */
  sqlFromCache: value<boolean>(() => false),
  /** SQL came from query memory, where it was already verified once. */
  fromMemory: value<boolean>(() => false),

  sql: value<string>(() => ""),
  feedback: value<SqlFeedback | null>(() => null),
  /** SQL drafts written by the model this run, the first one included. */
  generations: value<number>(() => 0),
  /** In-process identifier fixes; budgeted separately so they never cost a draft. */
  freeRepairs: value<number>(() => 0),
  valuesChecked: value<boolean>(() => false),
  verifyRetries: value<number>(() => 0),

  rows: value<Rows>(() => []),
  columns: value<string[]>(() => []),
  rowCount: value<number>(() => 0),
  /** sql_generated / sql_result already sent to the client. */
  published: value<boolean>(() => false),

  answer: value<string>(() => ""),
  clarification: value<{ question: string; options: string[] } | null>(() => null),
  /** Unrecoverable failure; the turn ends with message_failed. */
  errorMessage: value<string | null>(() => null),

  chartSpec: value<VisualizationChartSpec | null>(() => null),
  suggestions: value<string[]>(() => []),
  visualizationValidationStatus: value<VisualizationValidationStatus>(() => "pending"),
  visualizationValidationErrors: value<string[]>(() => []),
  visualizationValidationNarrowedFrom: value<string[]>(() => []),
  visualizationValidationDroppedFields: value<string[]>(() => []),
  narrowedVisualizationReason: value<string | null>(() => null),

  // Every model call adds its usage here, including repairs, checks, charts
  // and suggestions. The answer, chart and suggestion steps run in parallel,
  // so these need reducers rather than last-value-wins.
  tokenUsage: new ReducedValue(z.custom<TokenUsage | null>().default(() => null), {
    reducer: (left: TokenUsage | null, right: TokenUsage | null) => mergeTokenUsage(left, right),
  }),
  steps: appended<{ text: string; at: string }>(),
  toolCalls: appended<Record<string, unknown>>(),
  repairHistory: appended<Record<string, unknown>>(),
  schemaCorrections: appended<{ from: string; to: string; stage: string }>(),
});

export type State = typeof AgentState.State;
export type Update = typeof AgentState.Update;

/** Per-run dependencies, passed as LangGraph runtime context rather than state. */
export type RunContext = {
  request: AgentRunRequest;
  logger: RunLogger;
};

export const RunContextSchema = z.object({
  request: z.custom<AgentRunRequest>(),
  logger: z.custom<RunLogger>(),
});

export type NodeConfig = LangGraphRunnableConfig<RunContext>;

/** The request, an event emitter and model-call hooks for one node. */
export function runtime(config: NodeConfig, node: string) {
  const context = config.context!;
  const emit = (event: AgentStreamEvent) => config.writer?.(event);
  return {
    request: context.request,
    emit,
    signal: config.signal,
    hooks: {
      onLlmCall: context.logger.onLlmCall(node),
      onLlmResponse: context.logger.onLlmResponse(node),
    },
    /** Shows a progress line to the user now and returns it for the trace. */
    step(text: string) {
      const entry = { text, at: new Date().toISOString() };
      emit({ type: "agent_step", data: entry });
      return entry;
    },
  };
}
