import { SQLException } from "../exceptions/SQLException.js";

/**
 * A cheap first filter that gives the model a clear error to repair against.
 * It is not the security boundary: keyword matching cannot see side-effecting
 * functions. Enforcement is the read-only transaction (Postgres) and the
 * read-only file handle (SQLite) in query.ts.
 */
export function assertReadOnlySql(sql: string) {
  const trimmed = sql.trim().replace(/;+$/, "");
  const upper = trimmed.toUpperCase();

  if (!trimmed) {
    throw new SQLException("Generated SQL was empty.");
  }

  if (trimmed.includes(";")) {
    throw new SQLException("Only a single read-only SQL statement is allowed.", trimmed);
  }

  const allowedPrefix = ["SELECT", "WITH", "EXPLAIN", "PRAGMA"].some((keyword) =>
    upper.startsWith(keyword),
  );

  if (!allowedPrefix) {
    throw new SQLException("Only read-only SQL is allowed.", trimmed);
  }

  const blockedRegex =
    /\b(INSERT|UPDATE|DELETE|MERGE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|ATTACH|DETACH|VACUUM)\b/i;

  if (blockedRegex.test(trimmed)) {
    throw new SQLException("Unsafe SQL was blocked before execution.", trimmed);
  }
}