import { Annotation } from "@langchain/langgraph";
import { IntentKind } from "../graph/types.js";
import type { FieldResolutionEntry } from "../graph/types.js";
import type { TokenUsage, VisualizationCapabilityDecision, VisualizationChartSpec, VisualizationRequest, VisualizationValidationStatus } from "../types.js";
import { mergeTokenUsage } from "../utils/token.js";

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
  chartSpec: Annotation<VisualizationChartSpec | null>({
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
  // Set when the SQL was reused from the result cache (safe mode): SQL
  // generation is skipped but execution still runs so the data stays fresh.
  sqlFromCache: Annotation<boolean>({
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
  visualizationRequest: Annotation<VisualizationRequest | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  visualizationCapabilityDecision: Annotation<VisualizationCapabilityDecision | null>({
    reducer: (_left, right) => right,
    default: () => null,
  }),
  visualizationValidationStatus: Annotation<VisualizationValidationStatus>({
    reducer: (_left, right) => right,
    default: () => "pending",
  }),
  visualizationValidationErrors: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  visualizationValidationNarrowedFrom: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  visualizationValidationDroppedFields: Annotation<string[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
  narrowedVisualizationReason: Annotation<string | null>({
    reducer: (_left, right) => right,
    default: () => null,
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
  /**
   * Identifiers this run rewrote to match the catalog, so callers can assert on
   * structure instead of scraping step text.
   */
  schemaCorrections: Annotation<Array<{ from: string; to: string; stage: string }>>({
    reducer: (left, right) => left.concat(right),
    default: () => [],
  }),
  fieldResolutions: Annotation<FieldResolutionEntry[]>({
    reducer: (_left, right) => right,
    default: () => [],
  }),
});

export type GraphStateValue = typeof GraphState.State;
