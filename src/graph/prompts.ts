import { createHash } from "node:crypto";
import type { AgentRunRequest, DatabaseKnowledgeRuntime } from "../types.js";
import { buildHistoryDigest, normalizeQuestion } from "./policy.js";

export function buildCacheKey(request: AgentRunRequest) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        userId: request.userId,
        databaseSourceId: request.database.sourceId,
        schemaFingerprint:
          request.database.schemaFingerprint ?? request.knowledge.schemaFingerprint,
        llmConnectionId: request.llm.connectionId,
        provider: request.llm.provider,
        model: request.llm.model,
        question: normalizeQuestion(request.message),
        historyDigest: buildHistoryDigest(request.history),
      }),
    )
    .digest("hex");
}

export function buildSqlSystemPrompt(
  knowledge: DatabaseKnowledgeRuntime,
  options?: {
    wantsVisualization?: boolean;
    needsImplicitCountMetric?: boolean;
  },
) {
  const schemaLines = knowledge.tables.map((table) => {
    const columns = table.columns
      .map(
        (column) =>
          `${column.name} (${column.dataType}${column.isPrimaryKey ? ", PK" : ""}${column.isNullable ? "" : ", NOT NULL"})`,
      )
      .join(", ");
    const relationships =
      table.foreignKeys.length > 0
        ? table.foreignKeys
            .map(
              (foreignKey) =>
                `${foreignKey.sourceColumn} -> ${foreignKey.targetTable}.${foreignKey.targetColumn}`,
            )
            .join("; ")
        : "none";

    return `${table.schemaName ? `${table.schemaName}.` : ""}${table.name}: ${columns}. relationships: ${relationships}`;
  });

  return [
    "You generate SQL for analytics over SQLite or PostgreSQL.",
    "Return JSON with {\"sql\": string, \"rationale\": string}.",
    "Use one read-only statement only.",
    "Never produce INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, ATTACH, DETACH, or other write/admin commands.",
    "Prefer exact schema names and columns from the provided catalog.",
    "When you return computed columns, always alias them with short user-facing names. Never leave raw SQL expressions as column names.",
    "Prefer readable aliases such as performer_count, alias_count, country, total_revenue, or average_rating.",
    options?.wantsVisualization
      ? "The user explicitly wants a visualization. Prefer a result set that is easy to chart, with one category/time column and one numeric metric when possible."
      : "Only prepare chart-friendly result sets when the question clearly calls for it.",
    options?.needsImplicitCountMetric
      ? "If the user asks to visualize a category without naming a metric, group by that category and use COUNT(*) as the metric."
      : "Do not invent unsupported metrics.",
    `Knowledge summary: ${knowledge.summary || "No summary available."}`,
    "Catalog:",
    ...schemaLines,
  ].join("\n");
}

export function buildSqlRepairPrompt(
  knowledge: DatabaseKnowledgeRuntime,
  sql: string,
  error: string,
  options?: {
    wantsVisualization?: boolean;
    needsImplicitCountMetric?: boolean;
  },
) {
  return [
    buildSqlSystemPrompt(knowledge, options),
    "The prior SQL failed. Repair it and return JSON with only the replacement SQL.",
    `Previous SQL: ${sql}`,
    `Database error: ${error}`,
  ].join("\n");
}
