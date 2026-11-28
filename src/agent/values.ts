import { Command } from "@langchain/langgraph";
import { parseMongoQuery } from "../database/mongo.js";
import { executeReadOnlyQuery } from "../database/query.js";
import { SECRET_FIELD_PATTERN } from "../database/sanitize.js";
import type { AgentDatabaseRuntime, DatabaseCatalogTable, DatabaseKnowledgeRuntime } from "../types.js";
import { afterEmptyResult } from "./execute.js";
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

/** A filter to check, resolved to the catalog column it reads. */
type Target = { table: DatabaseCatalogTable; column: string; operator: "=" | "like" | "regex"; literals: string[] };

function sqlTargets(sql: string, knowledge: DatabaseKnowledgeRuntime): Target[] {
  return extractLiteralFilters(sql).flatMap((filter) => {
    const target = resolveFilterTable(sql, filter, knowledge);
    return target ? [{ ...target, operator: filter.operator, literals: filter.literals }] : [];
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * String filters in the leading $match stages of a MongoDB query: equality,
 * $eq, $in and $regex on the collection's own fields. A $match after a $lookup
 * or $group may name joined or computed fields, so the scan stops there.
 */
export function mongoTargets(text: string, knowledge: DatabaseKnowledgeRuntime): Target[] {
  let query;
  try {
    query = parseMongoQuery(text);
  } catch {
    return [];
  }
  const table = findTable(knowledge, query.collection);
  if (!table) return [];
  const targets: Target[] = [];

  const visit = (match: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(match)) {
      if (key === "$and" && Array.isArray(value)) {
        value.filter(isRecord).forEach(visit);
        continue;
      }
      const column = table.columns.find((candidate) => candidate.name === key)?.name;
      if (!column) continue;
      // Extended JSON parses {"$regex": ..., "$options": ...} into a BSONRegExp.
      const regex = isRecord(value) && value._bsontype === "BSONRegExp" ? value : isRecord(value) ? value.$regex : undefined;
      const condition = isRecord(value) && !("_bsontype" in value) ? value : { $eq: value };
      if (isRecord(regex) && typeof regex.pattern === "string") {
        targets.push({ table, column, operator: "regex", literals: [regex.pattern] });
      } else if (typeof regex === "string") {
        targets.push({ table, column, operator: "regex", literals: [regex] });
      } else if (typeof condition.$eq === "string") {
        targets.push({ table, column, operator: "=", literals: [condition.$eq] });
      } else if (Array.isArray(condition.$in) && condition.$in.length > 0 && condition.$in.every((item) => typeof item === "string")) {
        targets.push({ table, column, operator: "=", literals: condition.$in as string[] });
      }
    }
  };
  for (const stage of query.pipeline) {
    if (!isRecord(stage.$match)) break;
    visit(stage.$match);
  }
  return targets;
}

function quoteIdentifier(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Distinct values of a column: a sample of up to 100, or with `match` the
 * ones that match the literal, ignoring case. The sample alone cannot show
 * whether a name exists among thousands, so the literal is looked up directly
 * first.
 */
async function storedValues(
  database: AgentDatabaseRuntime,
  table: DatabaseCatalogTable,
  column: string,
  match?: { operator: Target["operator"]; literal: string },
): Promise<string[]> {
  let query: string;
  if (database.provider === "mongodb") {
    const filter = !match
      ? { $type: "string" }
      : { $regex: match.operator === "regex" ? match.literal : `^${escapeRegExp(match.literal)}$`, $options: "i" };
    query = JSON.stringify({
      collection: table.name,
      pipeline: [
        { $match: { [column]: filter } },
        { $group: { _id: `$${column}` } },
        { $limit: match ? 5 : 100 },
        { $project: { _id: 0, value: "$_id" } },
      ],
    });
  } else {
    const tableName =
      database.provider === "postgresql" && table.schemaName
        ? `${quoteIdentifier(table.schemaName)}.${quoteIdentifier(table.name)}`
        : quoteIdentifier(table.name);
    const columnName = quoteIdentifier(column);
    const where = !match
      ? `${columnName} IS NOT NULL`
      : `LOWER(${columnName}) ${match.operator === "=" ? "=" : "LIKE"} ${quoteLiteral(match.literal.toLowerCase())}`;
    query = `SELECT DISTINCT ${columnName} AS value FROM ${tableName} WHERE ${where} LIMIT ${match ? 5 : 100}`;
  }
  const result = await executeReadOnlyQuery(database, query);
  return result.rows.map((row) => String(row.value));
}

async function found(...args: Parameters<typeof storedValues>): Promise<string[]> {
  try {
    return await storedValues(...args);
  } catch {
    return [];
  }
}

function patternOf(operator: Target["operator"], literal: string): RegExp | null {
  if (operator === "like") return likeToRegExp(literal);
  try {
    return new RegExp(literal, "i");
  } catch {
    return null;
  }
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
 * When every filtered value exists, a joined query gets one rewrite aimed at
 * the join; otherwise the result really is empty.
 */
export async function checkValues(state: State, config: NodeConfig) {
  const { request, step } = runtime(config, "checkValues");
  const mongo = request.database.provider === "mongodb";
  const filters = (mongo ? mongoTargets : sqlTargets)(state.sql, request.knowledge);
  // A literal as it is written in the query, to swap a stored value in.
  const quote = mongo ? (value: string) => JSON.stringify(value) : quoteLiteral;
  if (filters.length === 0) {
    return new Command({ goto: afterEmptyResult(state), update: { valuesChecked: true } satisfies Update });
  }

  const steps = [step("The query found nothing; checking the values it filtered on...")];
  let sql = state.sql;
  const corrections: Array<{ from: string; to: string; stage: string }> = [];
  const mismatches: string[] = [];
  const matched: string[] = [];

  for (const target of filters.slice(0, MAX_PROBES)) {
    // The probe returns raw values to the model, so it skips columns whose
    // names look sensitive, as the row sanitizer does.
    if (SECRET_FIELD_PATTERN.test(target.column)) continue;

    let sample: string[];
    try {
      sample = await storedValues(request.database, target.table, target.column);
    } catch {
      continue;
    }

    for (const literal of target.literals) {
      const direct = await found(request.database, target.table, target.column, { operator: target.operator, literal });
      const values = [...new Set([...direct, ...sample])];
      if (target.operator !== "=") {
        const how = target.operator === "like" ? "LIKE" : "$regex";
        const pattern = patternOf(target.operator, literal);
        if (direct.length > 0) {
          matched.push(`${target.table.name}.${target.column} ${how} ${quoteLiteral(literal)} matches stored values (ignoring case): ${direct.map(quoteLiteral).join(", ")}.`);
        } else if (!pattern || !values.some((value) => pattern.test(value))) {
          mismatches.push(
            `No value in ${target.table.name}.${target.column} matches ${how} ${quoteLiteral(literal)}. Stored values include: ${values.slice(0, MAX_VALUES_SHOWN).map(quoteLiteral).join(", ")}.`,
          );
        }
        continue;
      }
      if (values.includes(literal)) {
        matched.push(`${target.table.name}.${target.column} holds ${quoteLiteral(literal)}.`);
        continue;
      }

      const normalized = literal.trim().toLowerCase();
      const caseOnly = values.filter((value) => value.trim().toLowerCase() === normalized);
      if (caseOnly.length === 1 && sql.includes(quote(literal))) {
        sql = sql.split(quote(literal)).join(quote(caseOnly[0]));
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

  // The filtered values exist, so in a joined query the rows were most likely
  // lost in the join: keys of different types (an ObjectId against its string
  // form) or formats never match. One rewrite, then the empty result stands.
  if (corrections.length === 0 && matched.length > 0 && /\bjoin\b|"\$lookup"/i.test(state.sql) && state.generations < MAX_GENERATIONS) {
    return new Command({
      goto: "generate",
      update: {
        valuesChecked: true,
        repairHistory: [{ ...repairHistory[0], matched }],
        steps: [...steps, step("The filtered values exist; checking how the tables are joined...")],
        feedback: {
          sql,
          issues: [
            "The query ran but returned no rows, although the values it filters on exist:",
            ...matched,
            "So the rows are lost elsewhere, most likely in a join whose two sides never hold equal values (different types or formats of the key), or in another filter. Fix that part; if the query is right, return it unchanged.",
          ],
        },
      } satisfies Update,
    });
  }

  return new Command({ goto: afterEmptyResult(state), update: { valuesChecked: true, repairHistory, steps } satisfies Update });
}
