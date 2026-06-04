import Database from "better-sqlite3";
import { MAX_SAMPLE_ROWS } from "../config.js";
import type { AgentDatabaseRuntime, DatabaseCatalogTable } from "../types.js";
import { openSqlite } from "./query.js";
import { collectSampleValues, normalizeName, sanitizeRow } from "./sanitize.js";

export async function introspectSqlite(
  database: AgentDatabaseRuntime,
): Promise<DatabaseCatalogTable[]> {
  const db = await openSqlite(database);
  try {
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
      )
      .all() as Array<{ name: string }>;

    return tables.map(({ name }) => {
      const columns = (db
        .prepare(`PRAGMA table_info("${name.replace(/"/g, '""')}")`)
        .all() ?? []) as Array<Record<string, unknown>>;
      const indexes = (db
        .prepare(`PRAGMA index_list("${name.replace(/"/g, '""')}")`)
        .all() ?? []) as Array<Record<string, unknown>>;
      const foreignKeys = (db
        .prepare(`PRAGMA foreign_key_list("${name.replace(/"/g, '""')}")`)
        .all() ?? []) as Array<Record<string, unknown>>;
      const rowCount =
        (
          db
            .prepare(
              `SELECT COUNT(*) as count FROM "${name.replace(/"/g, '""')}"`,
            )
            .get() as { count?: number } | undefined
        )?.count ?? null;
      const sampleRows = (
        db
          .prepare(
            `SELECT * FROM "${name.replace(/"/g, '""')}" ORDER BY RANDOM() LIMIT ${MAX_SAMPLE_ROWS}`,
          )
          .all() as Array<Record<string, unknown>>
      ).map(sanitizeRow);

      return {
        name,
        rowCount,
        sampleRows,
        columns: columns.map((column) => ({
          name: String(column.name ?? ""),
          normalizedName: normalizeName(String(column.name ?? "")),
          dataType: String(column.type ?? "TEXT"),
          isNullable: Number(column.notnull ?? 0) === 0,
          isPrimaryKey: Number(column.pk ?? 0) > 0,
          ordinalPosition: Number(column.cid ?? 0) + 1,
          sampleValues: collectSampleValues(
            sampleRows,
            String(column.name ?? ""),
          ),
        })),
        indexes: indexes.map((index) => ({
          name: String(index.name ?? "unnamed_index"),
          columns: resolveSqliteIndexColumns(
            db,
            name,
            String(index.name ?? ""),
          ),
          isUnique: Number(index.unique ?? 0) === 1,
          isPrimary: false,
        })),
        foreignKeys: foreignKeys.map((foreignKey) => ({
          constraintName: null,
          sourceColumn: String(foreignKey.from ?? ""),
          targetTable: String(foreignKey.table ?? ""),
          targetColumn: String(foreignKey.to ?? ""),
          targetSchema: null,
          onUpdate: String(foreignKey.on_update ?? ""),
          onDelete: String(foreignKey.on_delete ?? ""),
        })),
      } satisfies DatabaseCatalogTable;
    });
  } finally {
    db.close();
  }
}

function resolveSqliteIndexColumns(
  db: InstanceType<typeof Database>,
  _tableName: string,
  indexName: string,
) {
  if (!indexName) {
    return [];
  }

  return (
    db
      .prepare(`PRAGMA index_info("${indexName.replace(/"/g, '""')}")`)
      .all() as Array<{
      name?: string;
    }>
  )
    .map((row) => row.name ?? "")
    .filter(Boolean);
}
