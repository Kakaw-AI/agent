import { Client } from "pg";
import type { AgentDatabaseRuntime, DatabaseCatalogTable } from "../types.js";
import { MAX_SAMPLE_ROWS } from "./query.js";
import { collectSampleValues, normalizeName, sanitizeRow } from "./sanitize.js";

export async function introspectPostgres(
  database: AgentDatabaseRuntime,
): Promise<DatabaseCatalogTable[]> {
  const client = new Client({ connectionString: database.connectionString });
  await client.connect();

  try {
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

      tables.push({
        schemaName,
        name: tableName,
        rowCount: Number(rowCountResult.rows[0]?.count ?? 0),
        sampleRows,
        columns: columns.rows.map((column) => ({
          name: column.column_name,
          normalizedName: normalizeName(column.column_name),
          dataType: column.data_type,
          isNullable: column.is_nullable === "YES",
          isPrimaryKey: primaryKeyNames.has(column.column_name),
          ordinalPosition: column.ordinal_position,
          sampleValues: collectSampleValues(sampleRows, column.column_name),
        })),
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

function extractPostgresIndexColumns(indexDefinition: string) {
  const match = indexDefinition.match(/\((.+)\)/);
  if (!match) {
    return [];
  }

  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}
