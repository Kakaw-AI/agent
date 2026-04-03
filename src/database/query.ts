import Database from "better-sqlite3";
import { Pool } from "pg";
import type { AgentDatabaseRuntime } from "../types.js";
import { assertReadOnlySql } from "./safety.js";
import { sanitizeRow } from "./sanitize.js";

export type QueryResult = {
  rowCount: number;
  columns: string[];
  rows: Array<Record<string, unknown>>;
};

export const MAX_SAMPLE_ROWS = 3;
export const MAX_RESULT_ROWS = 200;

const pgPools = new Map<string, Pool>();

export function getPool(connectionString: string): Pool {
  if (!pgPools.has(connectionString)) {
    pgPools.set(connectionString, new Pool({ connectionString, max: 5 }));
  }
  return pgPools.get(connectionString)!;
}

export function openSqlite(database: AgentDatabaseRuntime) {
  if (!database.sqliteFilePath) {
    throw new Error("SQLite runtime is missing sqliteFilePath.");
  }

  return new Database(database.sqliteFilePath, {
    readonly: true,
    fileMustExist: true,
  });
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
