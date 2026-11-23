import { Client } from "pg";
import { MAX_SAMPLE_ROWS, QUERY_TIMEOUT_MS } from "../config.js";
import { guardedSocket } from "../net/public-host.js";
import type { AgentDatabaseRuntime, DatabaseCatalogTable } from "../types.js";
import {
  MAX_LISTED_VALUES,
  collectSampleValues,
  completeValueList,
  extractPostgresIndexColumns,
  normalizeName,
  sanitizeRow,
  shouldListValues,
} from "./sanitize.js";

/**
 * Every distinct value of a short text column, or null (see `completeValueList`).
 * The savepoint keeps one failed lookup (a timeout, a type without equality)
 * from aborting the read-only transaction the rest of introspection runs in.
 */
async function listPostgresValues(client: Client, qualifiedTable: string, columnName: string) {
  const quoted = `"${columnName.replace(/"/g, '""')}"`;
  await client.query("SAVEPOINT list_values");
  try {
    const result = await client.query<{ value: unknown }>(
      `SELECT DISTINCT ${quoted}::text AS value FROM ${qualifiedTable} WHERE ${quoted} IS NOT NULL LIMIT ${MAX_LISTED_VALUES + 1}`,
    );
    await client.query("RELEASE SAVEPOINT list_values");
    return completeValueList(result.rows.map((row) => row.value));
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT list_values");
    return null;
  }
}

export async function introspectPostgres(
  database: AgentDatabaseRuntime,
): Promise<DatabaseCatalogTable[]> {
  const client = new Client({
    connectionString: database.connectionString,
    connectionTimeoutMillis: 10_000,
    stream: guardedSocket,
  });
  await client.connect();

  try {
    // Introspection only reads. The transaction makes the database enforce
    // that, and bounds each statement (the row counts and random samples below
    // can be slow on large tables).
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);

    const tableRows = await client.query<{
      table_schema: string;
      table_name: string;
    }>(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('pg_catalog', 'information_schema')
      ORDER BY table_schema, table_name
    `);

    const tables: DatabaseCatalogTable[] = [];
    for (const row of tableRows.rows) {
      const tableName = row.table_name;
      const schemaName = row.table_schema;
      const qualified = `"${schemaName.replace(/"/g, '""')}"."${tableName.replace(/"/g, '""')}"`;
      const columns = await client.query<{
        column_name: string;
        data_type: string;
        is_nullable: "YES" | "NO";
        ordinal_position: number;
      }>(
        `
          SELECT column_name, data_type, is_nullable, ordinal_position
          FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2
          ORDER BY ordinal_position
        `,
        [schemaName, tableName],
      );
      const primaryKeys = await client.query<{ column_name: string }>(
        `
          SELECT kcu.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_schema = $1
            AND tc.table_name = $2
        `,
        [schemaName, tableName],
      );
      const indexes = await client.query<{ indexname: string; indexdef: string }>(
        `
          SELECT indexname, indexdef
          FROM pg_indexes
          WHERE schemaname = $1 AND tablename = $2
        `,
        [schemaName, tableName],
      );
      const foreignKeys = await client.query<{
        constraint_name: string;
        source_column: string;
        target_schema: string;
        target_table: string;
        target_column: string;
        update_rule: string;
        delete_rule: string;
      }>(
        `
          SELECT
            tc.constraint_name,
            kcu.column_name AS source_column,
            ccu.table_schema AS target_schema,
            ccu.table_name AS target_table,
            ccu.column_name AS target_column,
            rc.update_rule,
            rc.delete_rule
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kcu
            ON tc.constraint_name = kcu.constraint_name
           AND tc.table_schema = kcu.table_schema
          JOIN information_schema.constraint_column_usage ccu
            ON ccu.constraint_name = tc.constraint_name
           AND ccu.table_schema = tc.table_schema
          JOIN information_schema.referential_constraints rc
            ON rc.constraint_name = tc.constraint_name
           AND rc.constraint_schema = tc.table_schema
          WHERE tc.constraint_type = 'FOREIGN KEY'
            AND tc.table_schema = $1
            AND tc.table_name = $2
        `,
        [schemaName, tableName],
      );

      const rowCountResult = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text as count FROM ${qualified}`,
      );
      const sampleResult = await client.query(
        `SELECT * FROM ${qualified} ORDER BY random() LIMIT ${MAX_SAMPLE_ROWS}`,
      );
      const sampleRows = sampleResult.rows.map(sanitizeRow);
      const primaryKeyNames = new Set(primaryKeys.rows.map((item) => item.column_name));
      const rowCount = Number(rowCountResult.rows[0]?.count ?? 0);
      const catalogColumns = [];
      for (const column of columns.rows) {
        const isPrimaryKey = primaryKeyNames.has(column.column_name);
        const listed = shouldListValues({ name: column.column_name, dataType: column.data_type, isPrimaryKey }, rowCount)
          ? await listPostgresValues(client, qualified, column.column_name)
          : null;
        catalogColumns.push({
          name: column.column_name,
          normalizedName: normalizeName(column.column_name),
          dataType: column.data_type,
          isNullable: column.is_nullable === "YES",
          isPrimaryKey,
          ordinalPosition: column.ordinal_position,
          sampleValues: listed ?? collectSampleValues(sampleRows, column.column_name),
        });
      }

      tables.push({
        schemaName,
        name: tableName,
        rowCount,
        sampleRows,
        columns: catalogColumns,
        indexes: indexes.rows.map((index) => ({
          name: index.indexname,
          columns: extractPostgresIndexColumns(index.indexdef),
          isUnique: index.indexdef.includes("UNIQUE"),
          isPrimary: index.indexname.endsWith("_pkey"),
        })),
        foreignKeys: foreignKeys.rows.map((foreignKey) => ({
          constraintName: foreignKey.constraint_name,
          sourceColumn: foreignKey.source_column,
          targetTable: foreignKey.target_table,
          targetSchema: foreignKey.target_schema,
          targetColumn: foreignKey.target_column,
          onUpdate: foreignKey.update_rule,
          onDelete: foreignKey.delete_rule,
        })),
      });
    }

    return tables;
  } finally {
    await client.end();
  }
}

