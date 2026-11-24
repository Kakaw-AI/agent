import {
  IDENTIFIER_THRESHOLDS,
  bestMatch,
  normalizeIdentifier,
} from "./identifier-match.js";

export const SECRET_FIELD_PATTERN =/(password|secret|token|key|credential|auth|session)/i;

export function collectSampleValues(rows: Array<Record<string, unknown>>, columnName: string) {
  return rows
    .map((row) => row[columnName])
    .filter((value) => value !== undefined)
    .slice(0, 3);
}

/**
 * A text column with this many distinct values or fewer gets all of them in
 * the catalog instead of three random samples. Three random rows of a
 * 46-row `categories` table almost never show 'Home Decor', so the model
 * guessed a nearby name ('Home') and asked about that instead.
 */
export const MAX_LISTED_VALUES = 50;
/** Longer values are free text (descriptions, titles), not a closed set. */
const MAX_LISTED_VALUE_CHARS = 60;
/**
 * The distinct scan reads the whole column, so big tables skip it and keep
 * their random samples.
 * ponytail: size cutoff, not cardinality stats. Read pg_stats.n_distinct if a
 * large fact table's status column needs listing too.
 */
const MAX_VALUE_SCAN_ROWS = 200_000;
// `string` is the MongoDB type name.
const TEXT_TYPE = /char|text|clob|enum|user-defined|^string$/i;

/** Whether introspection should look up a column's distinct values. */
export function shouldListValues(
  column: { name: string; dataType: string; isPrimaryKey: boolean },
  rowCount: number | null,
): boolean {
  return (
    !column.isPrimaryKey &&
    rowCount !== null &&
    rowCount <= MAX_VALUE_SCAN_ROWS &&
    TEXT_TYPE.test(column.dataType) &&
    !SECRET_FIELD_PATTERN.test(column.name)
  );
}

/**
 * Turns the result of `SELECT DISTINCT col ... LIMIT MAX_LISTED_VALUES + 1`
 * into the column's complete value list, or null when the column is not a
 * short closed set (too many values, long text, non-text values).
 */
export function completeValueList(values: unknown[]): string[] | null {
  if (values.length === 0 || values.length > MAX_LISTED_VALUES) return null;
  if (!values.every((value) => typeof value === "string" && value.length <= MAX_LISTED_VALUE_CHARS)) return null;
  return [...(values as string[])].sort();
}

export function normalizeName(value: string) {
  return normalizeIdentifier(value);
}

export function sanitizeRow(row: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, sanitizeValue(key, value)]),
  );
}

function sanitizeValue(key: string, value: unknown): unknown {
  if (SECRET_FIELD_PATTERN.test(key)) {
    return "[redacted]";
  }
  // Uint8Array as well as Buffer: bytes that crossed a process boundary (the
  // SQLite query child) arrive as the plain typed array.
  if (value instanceof Uint8Array) {
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
export function normalizeColumnName(value: string) {
  return normalizeIdentifier(value);
}

/**
 * Resolves a result-set column by name: exact, then normalized, then a
 * conservative fuzzy match. The fuzzy stage covers the case where the model
 * aliased a column slightly differently from the name the caller expects.
 */
export function findColumnByName(columns: string[], candidate: string | null | undefined) {
  if (!candidate) {
    return null;
  }

  const exact = columns.find((column) => column === candidate);
  if (exact) {
    return exact;
  }

  const normalizedCandidate = normalizeColumnName(candidate);
  const normalized = columns.find(
    (column) => normalizeColumnName(column) === normalizedCandidate,
  );
  if (normalized) {
    return normalized;
  }

  return (
    bestMatch(
      candidate,
      columns,
      (column) => column,
      IDENTIFIER_THRESHOLDS.sqlAutoCorrect,
    )?.item ?? null
  );
}
export function extractPostgresIndexColumns(indexDefinition: string) {
  const match = indexDefinition.match(/\((.+)\)/);
  if (!match) {
    return [];
  }

  return match[1]
    .split(",")
    .map((part) => part.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}
