import { createHash } from "node:crypto";
import type {
  AgentDatabaseRuntime,
  AgentSyncResponse,
  DatabaseCatalogTable,
  DatabaseKnowledgeDocument,
} from "../types.js";
import { introspectPostgres } from "./postgres.js";
import { introspectSqlite } from "./sqlite.js";

export async function syncDatabase(
  database: AgentDatabaseRuntime,
): Promise<AgentSyncResponse> {
  const tables =
    database.provider === "sqlite"
      ? await introspectSqlite(database)
      : await introspectPostgres(database);
  const knowledgeDocuments = buildKnowledgeDocuments(database, tables);
  const schemaFingerprint = createHash("sha256")
    .update(JSON.stringify({ provider: database.provider, tables }))
    .digest("hex");

  return {
    sourceId: database.sourceId,
    status: "READY",
    memoryCount: knowledgeDocuments.length,
    schemaFingerprint,
    syncedAt: new Date().toISOString(),
    syncMetadata: {
      provider: database.provider,
      tableCount: tables.length,
      documentCount: knowledgeDocuments.length,
    },
    catalog: {
      tables,
      knowledgeDocuments,
    },
  };
}

function buildKnowledgeDocuments(
  database: AgentDatabaseRuntime,
  tables: DatabaseCatalogTable[],
): DatabaseKnowledgeDocument[] {
  const tableDocuments = tables.map((table) => ({
    scope: "table",
    referenceType: "table-summary",
    referenceKey: `${table.schemaName ?? "default"}.${table.name}`,
    content: [
      `${table.schemaName ? `${table.schemaName}.` : ""}${table.name}`,
      `${table.columns.length} columns`,
      table.rowCount != null ? `${table.rowCount} rows` : null,
      table.foreignKeys.length > 0
        ? `relations: ${table.foreignKeys
            .map(
              (foreignKey) =>
                `${foreignKey.sourceColumn} -> ${foreignKey.targetTable}.${foreignKey.targetColumn}`,
            )
            .join("; ")}`
        : "relations: none",
    ]
      .filter(Boolean)
      .join(" · "),
  }));

  return [
    {
      scope: "database",
      referenceType: "database-summary",
      referenceKey: database.sourceId,
      content: `${database.label} (${database.provider}) with ${tables.length} tables ready for query generation.`,
      metadata: {
        provider: database.provider,
        tableCount: tables.length,
      },
    },
    ...tableDocuments,
  ];
}
