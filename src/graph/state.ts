import { Annotation } from "@langchain/langgraph";
import type { TokenUsage } from "../types.js";
import type { IntentKind } from "./policy.js";

function mergeTokenUsage(left: TokenUsage | null, right: TokenUsage | null) {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }

  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}

export const GraphState = Annotation.Root({
  sql: Annotation<string>(),
  errorMessage: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  rowCount: Annotation<number>({
    reducer: (_left, right) => right,
    default: () => 0,
  }),
  rows: Annotation<Array<Record<string, unknown>>>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  columns: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  answer: Annotation<string>(),
  chartSpec: Annotation<Record<string, unknown> | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  suggestions: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  cacheKey: Annotation<string>(),
  cacheHit: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),
  intentKind: Annotation<IntentKind>({
    reducer: (_left, right) => right,
    default: () => "data_answer",
  }),
  wantsVisualization: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),
  needsImplicitCountMetric: Annotation<boolean>({
    reducer: (_left, right) => right,
    default: () => false,
  }),
  tokenUsage: Annotation<TokenUsage | null>({
    reducer: (left, right) => mergeTokenUsage(left, right),
    default: () => null,
  }),
  steps: Annotation<Array<{ text: string; at: string }>>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  toolCalls: Annotation<Array<Record<string, unknown>>>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  repairHistory: Annotation<Array<Record<string, unknown>>>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
});

export type GraphStateValue = typeof GraphState.State;
