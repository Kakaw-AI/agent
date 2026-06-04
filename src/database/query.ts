import Database from "better-sqlite3";
import { Pool } from "pg";
import { MAX_RESULT_ROWS } from "../config.js";
import type { AgentDatabaseRuntime } from "../types.js";
import { materializeSqlite } from "./materialize.js";
import { assertReadOnlySql } from "./safety.js";
import { sanitizeRow } from "./sanitize.js";
import { QueryResult } from "./types.js";

const pgPools = new Map<string, Pool>();

function getPool(connectionString: string): Pool {
  if (!pgPools.has(connectionString)) {
    pgPools.set(connectionString, new Pool({ connectionString, max: 5 }));
  }
  return pgPools.get(connectionString)!;
}

export async function openSqlite(database: AgentDatabaseRuntime) {
  const filePath = await materializeSqlite(database);

  return new Database(filePath, {
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
    const db = await openSqlite(database);
    try {
      const statement = db.prepare(sql);
      const columns = statement.columns().map((column) => column.name);
      const rows = statement.all() as Array<Record<string, unknown>>;
      const safeRows = rows.slice(0, MAX_RESULT_ROWS).map(sanitizeRow);
      return {
        rowCount: rows.length,
        columns,
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
