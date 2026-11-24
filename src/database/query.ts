import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { Pool } from "pg";
import { MAX_RESULT_ROWS, QUERY_TIMEOUT_MS } from "../config.js";
import { SQLException } from "../exceptions/SQLException.js";
import { guardedSocket } from "../net/public-host.js";
import type { AgentDatabaseRuntime } from "../types.js";
import { materializeSqlite } from "./materialize.js";
import { runMongoQuery } from "./mongo.js";
import { assertReadOnlySql } from "./safety.js";
import { sanitizeRow } from "./sanitize.js";
import { QueryResult } from "./types.js";

// One pool per connection string, least-recently-used first. Bounded so a
// long-running process does not hold a pool (and the credentials in its key)
// for every database it has ever queried.
const PG_POOL_MAX = 32;
const pgPools = new Map<string, Pool>();

function getPool(connectionString: string): Pool {
  const existing = pgPools.get(connectionString);
  if (existing) {
    pgPools.delete(connectionString);
    pgPools.set(connectionString, existing);
    return existing;
  }

  const pool = new Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 10_000,
    stream: guardedSocket,
  });
  // An idle client that loses its connection (the user's database restarts)
  // emits here. With no listener that is an uncaught error and the process dies.
  pool.on("error", () => undefined);
  pgPools.set(connectionString, pool);

  while (pgPools.size > PG_POOL_MAX) {
    const oldest = pgPools.entries().next();
    if (oldest.done) {
      break;
    }
    pgPools.delete(oldest.value[0]);
    void oldest.value[1].end().catch(() => undefined);
  }

  return pool;
}

export async function openSqlite(database: AgentDatabaseRuntime) {
  const filePath = await materializeSqlite(database);

  return new Database(filePath, {
    readonly: true,
    fileMustExist: true,
  });
}

// better-sqlite3 is synchronous: on the main thread one slow query stalls every
// other request. It also cannot be interrupted — a single aggregate over a
// large join sits inside native code, so a worker thread would stay busy (and
// keep the file locked) after terminate(). A child process can be killed for
// real. The script is inlined so it runs the same under tsx, vitest and the
// compiled build; the module path is resolved here and sent with the job.
// ponytail: one process per query (~60ms to start). Keep a small pool of warm
// children if SQLite query volume ever makes that visible.
const SQLITE_CHILD = `
process.once("message", (job) => {
  let reply;
  try {
    const Database = require(job.modulePath);
    const db = new Database(job.filePath, { readonly: true, fileMustExist: true });
    try {
      const statement = db.prepare(job.sql);
      const columns = statement.columns().map((column) => column.name);
      const rows = [];
      let rowCount = 0;
      for (const row of statement.iterate()) {
        if (rowCount < job.maxRows) rows.push(row);
        rowCount += 1;
      }
      reply = { result: { columns, rows, rowCount } };
    } finally {
      db.close();
    }
  } catch (error) {
    reply = { error: { message: String(error && error.message), code: error && error.code } };
  }
  process.send(reply, () => process.exit(0));
});
`;
const sqliteModulePath = createRequire(import.meta.url).resolve("better-sqlite3");

type SqliteChildReply =
  | { result: QueryResult; error?: undefined }
  | { result?: undefined; error: { message: string; code?: string } };

export function runSqliteQuery(
  filePath: string,
  sql: string,
  timeoutMs = QUERY_TIMEOUT_MS,
): Promise<QueryResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--input-type=commonjs", "-e", SQLITE_CHILD],
      {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        // Structured clone, so BLOB columns arrive as bytes rather than JSON.
        serialization: "advanced",
      },
    );
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(() =>
        reject(
          new SQLException(
            `The query ran longer than ${Math.round(timeoutMs / 1000)}s and was cancelled.`,
            sql,
          ),
        ),
      );
    }, timeoutMs);

    child.once("message", (message) => {
      const reply = message as SqliteChildReply;
      settle(() => {
        if (reply.error) {
          reject(
            Object.assign(new Error(reply.error.message), {
              code: reply.error.code,
            }),
          );
          return;
        }
        resolve({
          ...reply.result,
          rows: reply.result.rows.map(sanitizeRow),
        });
      });
    });
    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code) =>
      settle(() =>
        reject(new SQLException(`The SQLite query process exited early (code ${code}).`, sql)),
      ),
    );

    child.send({
      modulePath: sqliteModulePath,
      filePath,
      sql,
      maxRows: MAX_RESULT_ROWS,
    });
  });
}

const CURSOR_PREFIX = "DECLARE kakaw_cursor NO SCROLL CURSOR FOR ";

async function runPostgresQuery(
  connectionString: string,
  sql: string,
): Promise<QueryResult> {
  const client = await getPool(connectionString).connect();
  try {
    // The keyword check in assertReadOnlySql is a first filter, not a boundary.
    // The transaction is: Postgres itself refuses writes, DDL and sequence
    // changes inside it, and SET LOCAL scopes the timeout to this one query so
    // it also holds behind a transaction-mode pooler.
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`);

    // EXPLAIN cannot back a cursor, and its output is small.
    if (/^\s*EXPLAIN\b/i.test(sql)) {
      const result = await client.query(sql);
      return {
        rowCount: result.rows.length,
        columns: result.fields.map((field) => field.name),
        rows: result.rows.slice(0, MAX_RESULT_ROWS).map(sanitizeRow),
      };
    }

    // A cursor so only the rows we keep ever leave the database. Sending the
    // statement as-is would buffer the whole result set in this process first.
    await client.query(CURSOR_PREFIX + sql).catch((error: unknown) => {
      // Error positions are relative to the statement we sent; shift them back
      // so the repair prompt points at the right character of the user's SQL.
      const position = Number((error as { position?: unknown })?.position);
      if (Number.isFinite(position) && position > CURSOR_PREFIX.length) {
        (error as { position: string }).position = String(
          position - CURSOR_PREFIX.length,
        );
      }
      throw error;
    });
    const page = await client.query(
      `FETCH ${MAX_RESULT_ROWS} FROM kakaw_cursor`,
    );
    // MOVE counts the rest server-side without transferring it, which keeps
    // rowCount the true total. If counting itself hits the timeout the rows
    // already fetched are still good.
    const rest =
      page.rows.length < MAX_RESULT_ROWS
        ? 0
        : await client
            .query("MOVE FORWARD ALL FROM kakaw_cursor")
            .then((moved) => moved.rowCount ?? 0)
            .catch(() => 0);

    return {
      rowCount: page.rows.length + rest,
      columns: page.fields.map((field) => field.name),
      rows: page.rows.map(sanitizeRow),
    };
  } finally {
    // A failed ROLLBACK means the connection is unusable; drop it from the pool.
    const broken = await client.query("ROLLBACK").then(
      () => false,
      () => true,
    );
    client.release(broken);
  }
}

export async function executeReadOnlyQuery(
  database: AgentDatabaseRuntime,
  sql: string,
): Promise<QueryResult> {
  assertReadOnlySql(sql);
  const statement = sql.trim().replace(/;+$/, "");

  if (database.provider === "sqlite") {
    return runSqliteQuery(await materializeSqlite(database), statement);
  }

  if (database.provider === "mongodb") {
    return runMongoQuery(database, statement);
  }

  return runPostgresQuery(database.connectionString!, statement);
}
