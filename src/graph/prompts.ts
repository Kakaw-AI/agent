import { createHash } from "node:crypto";
import type { AgentRunRequest, DatabaseKnowledgeRuntime } from "../types.js";

export function buildCacheKey(request: AgentRunRequest) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        userId: request.userId,
        databaseSourceId: request.database.sourceId,
        schemaFingerprint:
          request.database.schemaFingerprint ?? request.knowledge.schemaFingerprint,
        provider: request.llm.provider,
        model: request.llm.model,
        question: request.message.trim().toLowerCase(),
      }),
    )
    .digest("hex");
}

export function buildSqlSystemPrompt(knowledge: DatabaseKnowledgeRuntime) {
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
    `Knowledge summary: ${knowledge.summary || "No summary available."}`,
    "Catalog:",
    ...schemaLines,
  ].join("\n");
}

export function buildSqlRepairPrompt(
  knowledge: DatabaseKnowledgeRuntime,
  sql: string,
  error: string,
) {
  return [
    buildSqlSystemPrompt(knowledge),
    "The prior SQL failed. Repair it and return JSON with only the replacement SQL.",
    `Previous SQL: ${sql}`,
    `Database error: ${error}`,
  ].join("\n");
}
