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
  sqliteFilePath?: string;
  sqliteOriginalFilename?: string;
};

export type AgentHistoryMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type AgentLlmRuntime =
  | {
      connectionId: string;
      provider: "openai" | "custom-openai" | "openrouter" | "anthropic" | "google";
      model: string;
      apiKey: string;
      baseUrl?: string;
      headers?: Record<string, string>;
    }
  | {
      connectionId: string;
      provider: "github-copilot";
      model: string;
      accessToken: string;
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

export type AgentStreamEvent =
  | { type: "message_started"; data: { messageId: string } }
  | { type: "agent_step"; data: { text: string } }
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
        spec: Record<string, unknown>;
      };
    }
  | {
      type: "message_completed";
      data: { messageId: string; content: string; tokenUsage?: TokenUsage };
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
        chartSpec?: Record<string, unknown>;
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
