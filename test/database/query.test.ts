import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_RESULT_ROWS } from "../../src/config.js";
import { resultTypes, runSqliteQuery } from "../../src/database/query.js";
import { assertReadOnlySql } from "../../src/database/safety.js";

describe("runSqliteQuery", () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "kakaw-query-test-"));
    file = join(dir, "test.sqlite");
    const db = new Database(file);
    db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, password TEXT)");
    db.exec("CREATE TABLE blobs (data BLOB)");
    db.prepare("INSERT INTO blobs (data) VALUES (?)").run(Buffer.from([1, 2, 3]));
    const insert = db.prepare("INSERT INTO items (name, password) VALUES (?, ?)");
    db.transaction(() => {
      for (let i = 0; i < MAX_RESULT_ROWS + 50; i += 1) {
        insert.run(`item-${i}`, "hunter2");
      }
    })();
    db.close();
  });

  // Async with retries: on Windows the killed query process (timeout test) can
  // take a moment to let go of the file.
  afterAll(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));

  it("caps the rows it returns but reports the true total", async () => {
    const result = await runSqliteQuery(file, "SELECT * FROM items ORDER BY id");
    expect(result.columns).toEqual(["id", "name", "password"]);
    expect(result.rows).toHaveLength(MAX_RESULT_ROWS);
    expect(result.rowCount).toBe(MAX_RESULT_ROWS + 50);
    expect(result.rows[0]).toEqual({ id: 1, name: "item-0", password: "[redacted]" });
  });

  it("describes binary columns instead of shipping the bytes", async () => {
    const result = await runSqliteQuery(file, "SELECT data FROM blobs");
    expect(result.rows[0]).toEqual({ data: "[binary:3]" });
  });

  it("surfaces SQLite errors with their message", async () => {
    await expect(runSqliteQuery(file, "SELECT nope FROM items")).rejects.toThrow(
      /no such column: nope/,
    );
  });

  it("cannot write, whatever the SQL says", async () => {
    await expect(
      runSqliteQuery(file, "INSERT INTO items (name) VALUES ('x')"),
    ).rejects.toThrow();
    const after = await runSqliteQuery(file, "SELECT COUNT(*) AS n FROM items");
    expect(after.rows[0]).toEqual({ n: MAX_RESULT_ROWS + 50 });
  });

  it("cancels a query that runs past the timeout", async () => {
    const runaway =
      "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT COUNT(*) FROM c";
    await expect(runSqliteQuery(file, runaway, 300)).rejects.toThrow(/cancelled/);
  });
});

describe("assertReadOnlySql", () => {
  it.each([
    "DELETE FROM users",
    "SELECT 1; DROP TABLE users",
    "WITH t AS (SELECT 1) MERGE INTO users USING t ON true WHEN MATCHED THEN DO NOTHING",
    "EXPLAIN ANALYZE UPDATE users SET name = 'x'",
    "",
  ])("rejects %s", (sql) => {
    expect(() => assertReadOnlySql(sql)).toThrow();
  });

  it("allows plain reads", () => {
    expect(() => assertReadOnlySql("SELECT * FROM users;")).not.toThrow();
    expect(() => assertReadOnlySql("WITH t AS (SELECT 1) SELECT * FROM t")).not.toThrow();
  });
});

describe("resultTypes", () => {
  it("returns PostgreSQL int8 and numeric values as numbers so they can be charted", () => {
    expect(resultTypes.getTypeParser(20)("5905")).toBe(5905);
    expect(resultTypes.getTypeParser(1700)("19169.00")).toBe(19169);
    // too big for a double: keep the exact text
    expect(resultTypes.getTypeParser(20)("9223372036854775807")).toBe("9223372036854775807");
    expect(resultTypes.getTypeParser(1700)("NaN")).toBe("NaN");
    expect(resultTypes.getTypeParser(25)("12")).toBe("12");
  });
});
