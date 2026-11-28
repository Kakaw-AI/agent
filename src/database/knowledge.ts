import { createHash } from "node:crypto";
import type {
  AgentDatabaseRuntime,
  AgentSyncResponse,
  DatabaseCatalogTable,
} from "../types.js";
import {
  countCatalogColumns,
  estimateCatalogTokens,
} from "./catalog-render.js";
import { introspectMongo } from "./mongo.js";
import { introspectPostgres } from "./postgres.js";
import { introspectSqlite } from "./sqlite.js";

export async function syncDatabase(
  database: AgentDatabaseRuntime,
): Promise<AgentSyncResponse> {
  const introspect = { sqlite: introspectSqlite, mongodb: introspectMongo, postgresql: introspectPostgres }[database.provider];
  const tables = await introspect(database);
  const schemaFingerprint = fingerprintCatalog(database.provider, tables);

  return {
    sourceId: database.sourceId,
    status: "READY",
    schemaFingerprint,
    syncedAt: new Date().toISOString(),
    syncMetadata: {
      provider: database.provider,
      tableCount: tables.length,
      // Recorded so the catalog size distribution across real sources is
      // queryable. The subsetting threshold is a decision about this number,
      // and until it is measured there is nothing to decide against.
      columnCount: countCatalogColumns(tables),
      estimatedCatalogTokens: estimateCatalogTokens(tables),
    },
    catalog: {
      tables,
    },
  };
}

/**
 * Hashes only the facts that describe the database itself.
 *
 * Hashing the whole table objects would fold in data that changes on every
 * sync (row counts, sample values), so every sync would look like a schema
 * change and retire query memory. The fingerprint should change when the
 * customer's schema changes, and not before.
 */
function fingerprintCatalog(
  provider: string,
  tables: DatabaseCatalogTable[],
): string {
  const projection = {
    provider,
    tables: tables.map((table) => ({
      schemaName: table.schemaName ?? null,
      name: table.name,
      columns: table.columns.map((column) => [
        column.name,
        column.dataType,
        column.isNullable,
        column.isPrimaryKey,
        column.ordinalPosition,
      ]),
      indexes: table.indexes,
      foreignKeys: table.foreignKeys,
    })),
  };

  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}
