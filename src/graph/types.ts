import type { DatabaseKnowledgeRuntime, VisualizationCapabilityDecision, VisualizationRequest } from "../types.js";

export type IntentKind =
  | "small_talk"
  | "data_answer"
  | "explicit_visualization"
  | "visualization_followup";

export type IntentDecision = {
  kind: IntentKind;
  wantsVisualization: boolean;
  visualizationRequest: VisualizationRequest | null;
};

export type VisualizationValidationInput = {
  request: VisualizationRequest;
  capabilityDecision?: VisualizationCapabilityDecision | null;
  columns: string[];
  rows: Array<Record<string, unknown>>;
};

export type FallbackChartSpec = {
  kind: "bar" | "line" | "pie" | "scatter" | "histogram";
  title: string;
  xField: string;
  yField: string;
  xLabel: string;
  yLabel: string;
  data: Array<Record<string, unknown>>;
};

export type DeterministicChartSpecInput = {
  question: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  visualizationRequest?: VisualizationRequest | null;
};

export type SqlPromptOptions = {
  wantsVisualization?: boolean;
  needsImplicitCountMetric?: boolean;
  derivedDimensionKeys?: string[];
  visualizationRequest?: VisualizationRequest | null;
};

/**
 * Marks a build as a repair attempt. The failing SQL and error are carried in
 * the user prompt, not here, so the cacheable system prefix stays stable.
 */
export type SqlRepairContext = {
  sql: string;
  error: string;
};

export type SqlPromptBuildInput = {
  knowledge: DatabaseKnowledgeRuntime;
  options?: SqlPromptOptions;
  repair?: SqlRepairContext;
};

export type SqlDraftAssessment = {
  ok: boolean;
  selectedAliases: string[];
  missingFields: string[];
  unreadableAliases: string[];
  errors: string[];
};

export type VisualizationSqlDraftInput = {
  sql: string;
  visualizationRequest: VisualizationRequest | null;
};

/** How a field named in the user's question was matched against the catalog. */
export type FieldResolutionKind =
  | "unchanged"
  | "corrected"
  | "ambiguous"
  | "unresolved"
  | "reserved";

export type FieldResolutionEntry = {
  slot: "category" | "metric" | "series" | "group";
  index: number;
  original: string;
  resolved: string | null;
  qualifiedName: string | null;
  score: number;
  kind: FieldResolutionKind;
  suggestions: string[];
};

export type VisualizationSqlUserPromptInput = {
  question: string;
  visualizationRequest: VisualizationRequest | null;
  needsImplicitCountMetric: boolean;
  priorSql?: string | null;
  priorErrors?: string[];
  /** Rendered driver error, hint and nearest-catalog-name candidates. */
  dbErrorBlock?: string | null;
  /** Catalog names close to fields the user asked for but we could not resolve. */
  fieldSuggestions?: Array<{ field: string; candidates: string[] }>;
};

