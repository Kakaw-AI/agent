export type DatabaseCatalogColumn = {
  name: string;
  normalizedName: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  ordinalPosition: number;
  sampleValues?: unknown[];
};

export type DatabaseCatalogIndex = {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
};

export type DatabaseCatalogForeignKey = {
  constraintName?: string | null;
  sourceColumn: string;
  targetTable: string;
  targetSchema?: string | null;
  targetColumn: string;
  onUpdate?: string | null;
  onDelete?: string | null;
};

export type DatabaseCatalogTable = {
  schemaName?: string | null;
  name: string;
  rowCount?: number | null;
  columns: DatabaseCatalogColumn[];
  indexes: DatabaseCatalogIndex[];
  foreignKeys: DatabaseCatalogForeignKey[];
  sampleRows?: Array<Record<string, unknown>>;
};

export type DatabaseKnowledgeDocument = {
  scope: string;
  referenceType: string;
  referenceKey: string;
  content: string;
  metadata?: Record<string, unknown>;
};

export type DatabaseKnowledgeRuntime = {
  schemaFingerprint: string | null;
  summary: string;
  tables: DatabaseCatalogTable[];
  knowledgeDocuments: DatabaseKnowledgeDocument[];
};

export type AgentDatabaseRuntime = {
  sourceId: string;
  provider: "postgresql" | "sqlite";
  label: string;
  schemaFingerprint?: string;
  connectionString?: string;
  // R2 object key (stable per upload) used to cache the materialized file, plus
  // a short-lived presigned GET URL the agent downloads from on a cache miss.
  sqliteObjectKey?: string;
  sqliteDownloadUrl?: string;
  sqliteOriginalFilename?: string;
};

export type AgentHistoryMessage = {
  role: "user" | "assistant" | "system";
  content: string;
  rows?: Array<Record<string, unknown>>;
  columns?: string[];
};

export type AgentLlmRuntime = {
  connectionId: string;
  provider: "openai" | "openrouter" | "anthropic" | "google" | "ollama" | "lm-studio";
  model: string;
  apiKey: string;
  baseUrl?: string;
  headers?: Record<string, string>;
};

export type AgentRunRequest = {
  requestId: string;
  conversationId: string;
  userId: string;
  messageId: string;
  message: string;
  history: AgentHistoryMessage[];
  database: AgentDatabaseRuntime;
  knowledge: DatabaseKnowledgeRuntime;
  llm: AgentLlmRuntime;
};

export type AgentSyncRequest = {
  requestId: string;
  userId: string;
  database: AgentDatabaseRuntime;
};

export type AgentSyncResponse = {
  sourceId: string;
  status: "READY" | "FAILED";
  memoryCount: number;
  schemaFingerprint: string;
  syncedAt: string;
  syncMetadata: Record<string, unknown>;
  catalog: {
    tables: DatabaseCatalogTable[];
    knowledgeDocuments: DatabaseKnowledgeDocument[];
  };
  error?: string;
};

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type VisualizationRequest = {
  categoryFields: string[];
  metricField: string | null;
  seriesField: string | null;
  groupField: string | null;
  networkViewRequested: boolean;
};

export type VisualizationRequestInput = {
  categoryFields?: Array<unknown> | string | null;
  metricField?: string | null;
  seriesField?: string | null;
  groupField?: string | null;
  networkViewRequested?: boolean;
};

export type VisualizationCapabilityKind =
  | "simple_xy_chart"
  | "grouped_bar"
  | "stacked_bar"
  | "network_graph"
  | "unsupported_needs_narrowing";

export type VisualizationCapabilityDecision = {
  kind: VisualizationCapabilityKind;
  supported: boolean;
  reason: string | null;
  requestedCategoryFields: string[];
  metricField: string | null;
  seriesField: string | null;
  groupField: string | null;
  networkViewRequested: boolean;
};

export type VisualizationValidationStatus = "pending" | "valid" | "invalid" | "narrowed";

export type VisualizationValidationResult = {
  status: VisualizationValidationStatus;
  errors: string[];
  narrowedFrom: string[];
  droppedFields: string[];
};

export type VisualizationOutcome = {
  request: VisualizationRequest;
  capabilityDecision: VisualizationCapabilityDecision | null;
  validation: VisualizationValidationResult | null;
  narrowingReason: string | null;
};

export type TraceAnalyticsOutcome =
  | "failed"
  | "no_rows"
  | "narrowed"
  | "chart_rendered"
  | "completed_text";

export type VisualizationChartSpecBase = {
  kind: "bar" | "line" | "pie" | "scatter" | "histogram" | "network";
  title?: string;
  xField: string;
  yField: string;
  xLabel: string;
  yLabel: string;
  data: Array<Record<string, unknown>>;
  seriesField?: string | null;
  stacked?: boolean;
  legendLabel?: string | null;
  validation?: VisualizationValidationResult | null;
  visualization?: VisualizationOutcome | null;
};

export type VisualizationChartSpec = VisualizationChartSpecBase & Record<string, unknown>;

export type AgentStreamEvent =
  | { type: "message_started"; data: { messageId: string } }
  | { type: "agent_step"; data: { text: string; at?: string } }
  | { type: "sql_generated"; data: { sql: string } }
  | {
      type: "sql_result";
      data: {
        rowCount: number;
        columns: string[];
        rows: Array<Record<string, unknown>>;
      };
    }
  | {
      type: "chart_generated";
      data: {
        chartType: string;
        title?: string;
        spec: VisualizationChartSpec;
        visualizationOutcome?: VisualizationOutcome | null;
      };
    }
  | {
      type: "message_completed";
      data: {
        messageId: string;
        content: string;
        tokenUsage?: TokenUsage;
        visualizationOutcome?: VisualizationOutcome | null;
        analyticsOutcome?: TraceAnalyticsOutcome;
      };
    }
  | {
      type: "suggestions_generated";
      data: { messageId: string; suggestions: string[] };
    }
  | {
      type: "agent_trace";
      data: {
        steps: Array<{ text: string; at: string }>;
        toolCalls: Array<Record<string, unknown>>;
      repairHistory: Array<Record<string, unknown>>;
      cacheKey?: string;
      cacheHit?: boolean;
      chartSpec?: VisualizationChartSpec | null;
      visualizationOutcome?: VisualizationOutcome | null;
      analyticsOutcome?: TraceAnalyticsOutcome;
      rowCount?: number;
    };
  }
  | {
      type: "message_failed";
      data: {
        messageId: string;
        error: string;
        errorInfo?: Record<string, unknown>;
      };
    };
