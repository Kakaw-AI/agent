import type { DatabaseKnowledgeRuntime, VisualizationCapabilityDecision, VisualizationRequest } from "../types.js";



export type {
  VisualizationCapabilityDecision,
  VisualizationChartSpec,
  VisualizationOutcome,
  VisualizationRequest,
  VisualizationRequestInput,
  VisualizationValidationResult,
  VisualizationValidationStatus
} from "../types.js";

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

export type FailurePresentation = {
  publicMessage: string;
  stepText: string;
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

export type VisualizationSqlUserPromptInput = {
  question: string;
  visualizationRequest: VisualizationRequest | null;
  needsImplicitCountMetric: boolean;
  priorSql?: string | null;
  priorErrors?: string[];
};

export type ChartPlanLlmResponse = {
  kind: "bar" | "line" | "pie" | "scatter" | "histogram";
  title: string;
  xField: string;
  yField: string;
};