import type { SchemaIndex } from "./schema-index.js";

/**
 * Normalizes driver errors into one shape.
 *
 * Postgres attaches far more than a message to a failed query — a SQLSTATE
 * code, the offending character position, and its own `HINT` naming the column
 * it thinks you meant. That hint comes from the planner with full scope
 * knowledge, which no amount of client-side guessing can match, and it used to
 * be discarded along with everything else except `error.message`.
 */

export type DbErrorKind =
  | "undefined_column"
  | "undefined_table"
  | "undefined_function"
  | "ambiguous_column"
  | "syntax"
  | "other";

export type NormalizedDbError = {
  message: string;
  code: string | null;
  kind: DbErrorKind;
  /** Postgres HINT, verbatim. Null for SQLite, which does not produce one. */
  hint: string | null;
  detail: string | null;
  /** 1-based character offset into the SQL, when the driver reports it. */
  position: number | null;
  /** The identifier the database could not resolve, when it names one. */
  missingIdentifier: string | null;
  raw: unknown;
};

const POSTGRES_CODE_KINDS: Record<string, DbErrorKind> = {
  "42703": "undefined_column",
  "42P01": "undefined_table",
  "42883": "undefined_function",
  "42702": "ambiguous_column",
  "42601": "syntax",
};

const IDENTIFIER_PATTERNS: Array<[RegExp, DbErrorKind]> = [
  [/column "?([\w$.]+)"? does not exist/i, "undefined_column"],
  [/relation "?([\w$.]+)"? does not exist/i, "undefined_table"],
  [/function "?([\w$.]+)"?.* does not exist/i, "undefined_function"],
  [/column reference "?([\w$.]+)"? is ambiguous/i, "ambiguous_column"],
  [/no such column:\s*([\w$.]+)/i, "undefined_column"],
  [/no such table:\s*([\w$.]+)/i, "undefined_table"],
  [/no such function:\s*([\w$.]+)/i, "undefined_function"],
  [/ambiguous column name:\s*([\w$.]+)/i, "ambiguous_column"],
];

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.trim() ? value : null;
}

export function normalizeDbError(error: unknown): NormalizedDbError {
  const message =
    error instanceof Error
      ? error.message || "SQL execution failed."
      : typeof error === "string" && error
        ? error
        : "SQL execution failed.";

  // Duck-typed rather than `instanceof DatabaseError`: pg re-exports that class
  // from pg-protocol, so identity breaks whenever the dependency is duplicated
  // in the tree.
  const source =
    error && typeof error === "object"
      ? (error as unknown as Record<string, unknown>)
      : {};

  const code = readString(source, "code");
  const hint = readString(source, "hint");
  const detail = readString(source, "detail");
  const rawPosition = source["position"];
  const position =
    typeof rawPosition === "number"
      ? rawPosition
      : typeof rawPosition === "string" && /^\d+$/.test(rawPosition)
        ? Number.parseInt(rawPosition, 10)
        : null;

  let kind: DbErrorKind = (code && POSTGRES_CODE_KINDS[code]) || "other";
  let missingIdentifier: string | null = null;

  for (const [pattern, patternKind] of IDENTIFIER_PATTERNS) {
    const match = message.match(pattern);
    if (match) {
      missingIdentifier = match[1] ?? null;
      if (kind === "other") {
        kind = patternKind;
      }
      break;
    }
  }

  if (kind === "other" && /syntax error/i.test(message)) {
    kind = "syntax";
  }

  return {
    message,
    code,
    kind,
    hint,
    detail,
    position,
    missingIdentifier,
    raw: error,
  };
}

/** Strips a leading table qualifier: `orders.custmer_id` -> `custmer_id`. */
export function bareIdentifier(identifier: string): string {
  const parts = identifier.split(".");
  return parts[parts.length - 1] ?? identifier;
}

function excerptAround(sql: string, position: number): string | null {
  if (position <= 0 || position > sql.length) {
    return null;
  }
  const start = Math.max(0, position - 40);
  const end = Math.min(sql.length, position + 40);
  return sql.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Renders the volatile half of a repair prompt: what the database said, plus
 * the closest catalog names we can offer. This belongs in the user message so
 * the schema catalog in the system prompt stays byte-identical and cacheable.
 */
export function describeDbErrorForPrompt(
  error: NormalizedDbError,
  index: SchemaIndex,
  sql: string,
): string {
  const lines: string[] = [
    `Database error${error.code ? ` (${error.code})` : ""}: ${error.message}`,
  ];

  if (error.hint) {
    lines.push(`Database hint: ${error.hint}`);
  }
  if (error.detail) {
    lines.push(`Database detail: ${error.detail}`);
  }
  if (error.position !== null) {
    const excerpt = excerptAround(sql, error.position);
    lines.push(
      `Error position: character ${error.position}${excerpt ? ` — near: ${excerpt}` : ""}`,
    );
  }

  if (error.missingIdentifier) {
    const bare = bareIdentifier(error.missingIdentifier);
    const suggestions =
      error.kind === "undefined_table"
        ? index.suggestTables(bare)
        : index.suggestColumns(bare);

    if (suggestions.length > 0) {
      const rendered = suggestions
        .map((entry) => `${entry.qualifiedName} (${entry.score.toFixed(2)})`)
        .join(", ");
      lines.push(
        `Closest catalog ${error.kind === "undefined_table" ? "tables" : "columns"} to "${error.missingIdentifier}": ${rendered}`,
      );
    }
  }

  lines.push(
    "Use only identifiers that appear in the catalog in the system prompt.",
  );

  return lines.join("\n");
}
