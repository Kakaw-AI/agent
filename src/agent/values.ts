import { Command } from "@langchain/langgraph";
import { executeReadOnlyQuery } from "../database/query.js";
import { SECRET_FIELD_PATTERN } from "../database/sanitize.js";
import type { AgentDatabaseRuntime, DatabaseCatalogTable, DatabaseKnowledgeRuntime } from "../types.js";
import { MAX_GENERATIONS } from "./plan.js";
import { type NodeConfig, runtime, type State, type Update } from "./state.js";

/** Filters looked up per empty result; each is one small query. */
const MAX_PROBES = 3;
/** Stored values shown back to the model. */
const MAX_VALUES_SHOWN = 30;

const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const COLUMN_REF = String.raw`(${IDENT}(?:\.${IDENT})?)`;
const STRING = String.raw`'((?:[^']|'')*)'`;
const WRAPPED_COLUMN = String.raw`(?:(?:lower|upper|trim)\(\s*${COLUMN_REF}\s*\)|${COLUMN_REF})`;
const COMPARISON = new RegExp(
  String.raw`${WRAPPED_COLUMN}\s*(=|i?like)\s*(?:(?:lower|upper|trim)\(\s*)?${STRING}`,
  "gi",
);
const MEMBERSHIP = new RegExp(String.raw`${WRAPPED_COLUMN}\s+in\s*\(\s*(${STRING}(?:\s*,\s*${STRING})*)\s*\)`, "gi");
const SOURCE = new RegExp(String.raw`\b(?:from|join)\s+(${IDENT}(?:\.${IDENT})?)(?:\s+(?:as\s+)?(?!on\b|where\b|join\b|left\b|right\b|inner\b|group\b|order\b|limit\b)([A-Za-z_][\w$]*))?`, "gi");

export type LiteralFilter = {
  qualifier: string | null;
  column: string;
  operator: "=" | "like";
  literals: string[];
};

const unquote = (identifier: string) => identifier.replace(/^"|"$/g, "");
const unescape = (literal: string) => literal.replace(/''/g, "'");

function splitColumn(reference: string) {
  const parts = reference.split(".").map(unquote);
  return parts.length === 2 ? { qualifier: parts[0], column: parts[1] } : { qualifier: null, column: parts[0] };
}

/**
 * Equality, IN and LIKE filters against string literals, best-effort.
 *
 * A lexer pass, not a parser: it only needs to find the filters most likely to
 * explain an empty result, and a filter it misses simply is not checked.
 * Negated filters are left out, since they cannot empty a result by naming a
 * value that does not exist.
 */
export function extractLiteralFilters(sql: string): LiteralFilter[] {
  const filters: LiteralFilter[] = [];

  for (const match of sql.matchAll(COMPARISON)) {
    const reference = splitColumn(match[1] ?? match[2]);
    // In "status NOT LIKE 'x'" the pattern lands on NOT as if it were a column.
    if (reference.column.toLowerCase() === "not") continue;
    filters.push({
      ...reference,
      operator: match[3].toLowerCase() === "=" ? "=" : "like",
      literals: [unescape(match[4])],
    });
  }

  for (const match of sql.matchAll(MEMBERSHIP)) {
    const literals = [...match[3].matchAll(new RegExp(STRING, "g"))].map((literal) => unescape(literal[1]));
    filters.push({ ...splitColumn(match[1] ?? match[2]), operator: "=", literals });
  }

  return filters;
}

function findTable(knowledge: DatabaseKnowledgeRuntime, reference: string): DatabaseCatalogTable | undefined {
  const { qualifier: schema, column: name } = splitColumn(reference);
  return knowledge.tables.find(
    (table) =>
      table.name.toLowerCase() === name.toLowerCase() &&
      (!schema || (table.schemaName ?? "").toLowerCase() === schema.toLowerCase()),
  );
}

/** The catalog table a filter's column belongs to, via the query's FROM/JOIN aliases. */
export function resolveFilterTable(
  sql: string,
  filter: LiteralFilter,
  knowledge: DatabaseKnowledgeRuntime,
): { table: DatabaseCatalogTable; column: string } | null {
  const sources: Array<{ table: DatabaseCatalogTable; alias: string | null }> = [];
  for (const match of sql.matchAll(SOURCE)) {
    const table = findTable(knowledge, match[1]);
    if (table) sources.push({ table, alias: match[2]?.toLowerCase() ?? null });
  }

  const hasColumn = (table: DatabaseCatalogTable) =>
    table.columns.find((column) => column.name.toLowerCase() === filter.column.toLowerCase());

  const candidates = filter.qualifier
    ? sources.filter(
        ({ table, alias }) =>
          alias === filter.qualifier!.toLowerCase() || table.name.toLowerCase() === filter.qualifier!.toLowerCase(),
      )
    : sources;

  const matches = candidates.filter(({ table }) => hasColumn(table));
  if (matches.length !== 1) return null;
  return { table: matches[0].table, column: hasColumn(matches[0].table)!.name };
}

function quoteIdentifier(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

async function storedValues(database: AgentDatabaseRuntime, table: DatabaseCatalogTable, column: string): Promise<string[]> {
  const tableName =
    database.provider === "postgresql" && table.schemaName
      ? `${quoteIdentifier(table.schemaName)}.${quoteIdentifier(table.name)}`
      : quoteIdentifier(table.name);
  const columnName = quoteIdentifier(column);
  const result = await executeReadOnlyQuery(
    database,
    `SELECT DISTINCT ${columnName} AS value FROM ${tableName} WHERE ${columnName} IS NOT NULL LIMIT 100`,
  );
  return result.rows.map((row) => String(row.value));
}

function likeToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

const quoteLiteral = (value: string) => `'${value.replace(/'/g, "''")}'`;

/**
 * Runs when a query came back empty. A filter on a value the column does not
 * hold is the most common way a correct-looking query answers nothing: the
 * model wrote 'cancelled' for 'Cancelled', or 'APAC' for 'Asia Pacific'.
 *
 * When the only difference is case or spacing the literal is swapped for the
 * stored value and the query runs again, with no model call. Otherwise the
 * model rewrites the query, this time seeing the values the column holds.
 * A filter whose value does exist means the result really is empty.
 */
export async function checkValues(state: State, config: NodeConfig) {
  const { request, step } = runtime(config, "checkValues");
  const filters = extractLiteralFilters(state.sql);
  if (filters.length === 0) {
    return new Command({ goto: "accept", update: { valuesChecked: true } satisfies Update });
  }

  const steps = [step("The query found nothing; checking the values it filtered on...")];
  let sql = state.sql;
  const corrections: Array<{ from: string; to: string; stage: string }> = [];
  const mismatches: string[] = [];

  for (const filter of filters.slice(0, MAX_PROBES)) {
    const target = resolveFilterTable(state.sql, filter, request.knowledge);
    // The probe returns raw values to the model, so it skips columns whose
    // names look sensitive, as the row sanitizer does.
    if (!target || SECRET_FIELD_PATTERN.test(target.column)) continue;

    let values: string[];
    try {
      values = await storedValues(request.database, target.table, target.column);
    } catch {
      continue;
    }

    for (const literal of filter.literals) {
      if (filter.operator === "like") {
        if (!values.some((value) => likeToRegExp(literal).test(value))) {
          mismatches.push(
            `No value in ${target.table.name}.${target.column} matches LIKE ${quoteLiteral(literal)}. Stored values include: ${values.slice(0, MAX_VALUES_SHOWN).map(quoteLiteral).join(", ")}.`,
          );
        }
        continue;
      }
      if (values.includes(literal)) continue;

      const normalized = literal.trim().toLowerCase();
      const caseOnly = values.filter((value) => value.trim().toLowerCase() === normalized);
      if (caseOnly.length === 1 && sql.includes(quoteLiteral(literal))) {
        sql = sql.split(quoteLiteral(literal)).join(quoteLiteral(caseOnly[0]));
        corrections.push({ from: literal, to: caseOnly[0], stage: "values" });
        continue;
      }
      mismatches.push(
        `${target.table.name}.${target.column} has no value ${quoteLiteral(literal)}. Stored values include: ${values.slice(0, MAX_VALUES_SHOWN).map(quoteLiteral).join(", ")}.`,
      );
    }
  }

  const repairHistory = [{ stage: "value_check", sql: state.sql, corrections, mismatches }];

  if (corrections.length > 0 && mismatches.length === 0) {
    return new Command({
      goto: "execute",
      update: {
        sql,
        valuesChecked: true,
        repairHistory,
        schemaCorrections: corrections,
        steps: [...steps, step(`Retrying with the stored ${corrections.length === 1 ? "value" : "values"} ${corrections.map((c) => quoteLiteral(c.to)).join(", ")}.`)],
      } satisfies Update,
    });
  }

  // Out of drafts, the empty result is still a valid (if unhelpful) answer.
  if (mismatches.length > 0 && state.generations < MAX_GENERATIONS) {
    return new Command({
      goto: "generate",
      update: {
        valuesChecked: true,
        repairHistory,
        steps,
        feedback: {
          sql,
          issues: ["The query ran but returned no rows because a filter names a value the column does not contain.", ...mismatches],
        },
      } satisfies Update,
    });
  }

  return new Command({ goto: "accept", update: { valuesChecked: true, repairHistory, steps } satisfies Update });
}
