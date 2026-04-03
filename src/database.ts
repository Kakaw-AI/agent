import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { Client, Pool } from "pg";
import type {
  AgentDatabaseRuntime,
  AgentSyncResponse,
  DatabaseCatalogColumn,
  DatabaseCatalogForeignKey,
  DatabaseCatalogIndex,
  DatabaseCatalogTable,
  DatabaseKnowledgeDocument,
} from "./types.js";

type QueryResult = {
  rowCount: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
};

const SECRET_FIELD_PATTERN =
  /(password|secret|token|key|credential|auth|session)/i;

const pgPools = new Map<string, Pool>();

function getPool(connectionString: string): Pool {
  if (!pgPools.has(connectionString)) {
    pgPools.set(connectionString, new Pool({ connectionString, max: 5 }));
  }
  return pgPools.get(connectionString)!;
}
const MAX_SAMPLE_ROWS = 3;
const MAX_RESULT_ROWS = 200;

export async function syncDatabase(
  database: AgentDatabaseRuntime,
): Promise<AgentSyncResponse> {
  const tables =
    database.provider === "sqlite"
      ? introspectSqlite(database)
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

export async function executeReadOnlyQuery(
  database: AgentDatabaseRuntime,
  sql: string,
): Promise<QueryResult> {
  assertReadOnlySql(sql);

  if (database.provider === "sqlite") {
    const db = openSqlite(database);
    try {
      const statement = db.prepare(sql);
      const rows = statement.all() as Array<Record<string, unknown>>;
      const safeRows = rows.slice(0, MAX_RESULT_ROWS).map(sanitizeRow);
      return {
        rowCount: rows.length,
        columns: safeRows[0] ? Object.keys(safeRows[0]) : [],
        rows: safeRows,
      };
    } finally {
      db.close();
    }
  }

  const pool = getPool(database.connectionString!);
  const client = await pool.connect();
  try {
    const result = await client.query(sql);
    const rows = result.rows.slice(0, MAX_RESULT_ROWS).map(sanitizeRow);
    return {
      rowCount: result.rowCount ?? rows.length,
      columns: result.fields.map((field) => field.name),
      rows,
    };
  } finally {
    client.release();
  }
}

function introspectSqlite(
  database: AgentDatabaseRuntime,
): DatabaseCatalogTable[] {
  const db = openSqlite(database);
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

async function introspectPostgres(
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
      const indexes = await client.query<{
        indexname: string;
        indexdef: string;
      }>(
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
      const primaryKeyNames = new Set(
        primaryKeys.rows.map((item) => item.column_name),
      );

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

function collectSampleValues(
  rows: Array<Record<string, unknown>>,
  columnName: string,
) {
  return rows
    .map((row) => row[columnName])
    .filter((value) => value !== undefined)
    .slice(0, MAX_SAMPLE_ROWS);
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

function openSqlite(database: AgentDatabaseRuntime) {
  if (!database.sqliteFilePath) {
    throw new Error("SQLite runtime is missing sqliteFilePath.");
  }

  return new Database(database.sqliteFilePath, {
    readonly: true,
    fileMustExist: true,
  });
}

function assertReadOnlySql(sql: string) {
  const trimmed = sql.trim().replace(/;+$/, "");
  const upper = trimmed.toUpperCase();

  if (!trimmed) {
    throw new Error("Generated SQL was empty.");
  }

  if (trimmed.includes(";")) {
    throw new Error("Only a single read-only SQL statement is allowed.");
  }

  const allowedPrefix = ["SELECT", "WITH", "EXPLAIN", "PRAGMA"].some(
    (keyword) => upper.startsWith(keyword),
  );
  if (!allowedPrefix) {
    throw new Error("Only read-only SQL is allowed.");
  }

  const blocked = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "DROP",
    "ALTER",
    "CREATE",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "ATTACH",
    "DETACH",
    "VACUUM",
  ];
  if (blocked.some((keyword) => upper.includes(keyword))) {
    throw new Error("Unsafe SQL was blocked before execution.");
  }
}

function normalizeName(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w]+/g, "_")
    .replace(/__+/g, "_")
    .replace(/^_|_$/g, "");
}

function sanitizeRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, sanitizeValue(key, value)]),
  );
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (SECRET_FIELD_PATTERN.test(key)) {
    return "[redacted]";
  }

  if (Buffer.isBuffer(value)) {
    return `[binary:${value.length}]`;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.slice(0, 10).map((entry) => sanitizeValue(key, entry));
  }

  if (value && typeof value === "object") {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return String(value);
    }
  }

  if (typeof value === "string" && value.length > 300) {
    return `${value.slice(0, 297)}...`;
  }

  return value;
}
