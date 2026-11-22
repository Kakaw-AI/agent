import { Command } from "@langchain/langgraph";
import {
  bareIdentifier,
  describeDbErrorForPrompt,
  normalizeDbError,
  type NormalizedDbError,
} from "../database/db-error.js";
import { IDENTIFIER_THRESHOLDS } from "../database/identifier-match.js";
import { executeReadOnlyQuery } from "../database/query.js";
import { getSchemaIndex, type SchemaIndex } from "../database/schema-index.js";
import { assessVisualizationSqlDraft } from "../graph/qa/assessment.js";
import {
  buildVisualizationNarrowingAnswer,
  decideVisualizationCapability,
  validateVisualizationResult,
} from "../graph/visualization.js";
import { webSearchConfigured } from "../net/web-search.js";
import { retryOrGiveUp } from "./plan.js";
import { type NodeConfig, runtime, type State, type Update } from "./state.js";

/** In-process identifier fixes per run; they cost no model call but must not loop. */
const MAX_FREE_REPAIRS = 2;

/** Off only to measure what the check is worth (see eval/). */
const VERIFY_RESULTS = (process.env.VERIFY_RESULTS ?? "true").toLowerCase() !== "false";

/**
 * Rewrites an identifier the database rejected, when the catalog offers one
 * clearly better candidate.
 *
 * Only whole-word, unquoted occurrences are touched: a quoted identifier was
 * written deliberately and is case-sensitive in Postgres, and rewriting inside
 * a string literal would silently change what the query means. Returns null
 * whenever the match is weak, contested, or unsafe to splice.
 */
export function applyFreeIdentifierRepair(
  sql: string,
  error: NormalizedDbError,
  index: SchemaIndex,
): { sql: string; from: string; to: string } | null {
  if (error.kind !== "undefined_column" && error.kind !== "undefined_table") {
    return null;
  }
  if (!error.missingIdentifier) {
    return null;
  }

  const missing = bareIdentifier(error.missingIdentifier);
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(missing)) {
    return null;
  }

  const options = { minScore: IDENTIFIER_THRESHOLDS.sqlAutoCorrect };
  const resolution =
    error.kind === "undefined_table"
      ? index.resolveTable(missing, options)
      : index.resolveColumn(missing, options);

  if (!resolution || resolution.ambiguous) {
    return null;
  }

  const replacement = "column" in resolution ? resolution.column.name : resolution.table.name;
  if (replacement === missing) {
    return null;
  }
  // Only splice names that need no quoting; anything else would require getting
  // dialect-specific escaping right inside arbitrary SQL.
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(replacement)) {
    return null;
  }

  const rewritten = replaceUnquotedIdentifier(sql, missing, replacement);
  if (rewritten === sql) {
    return null;
  }

  return { sql: rewritten, from: missing, to: replacement };
}

/**
 * Replaces whole-word occurrences of an identifier, skipping string literals,
 * quoted identifiers and comments.
 */
function replaceUnquotedIdentifier(sql: string, from: string, to: string): string {
  let result = "";
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    if (char === "'" || char === '"' || char === "`") {
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === char) {
          if (sql[end + 1] === char) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      result += sql.slice(index, Math.min(end + 1, sql.length));
      index = end + 1;
      continue;
    }

    if (char === "-" && sql[index + 1] === "-") {
      const end = sql.indexOf("\n", index);
      const stop = end === -1 ? sql.length : end;
      result += sql.slice(index, stop);
      index = stop;
      continue;
    }

    if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      const stop = end === -1 ? sql.length : end + 2;
      result += sql.slice(index, stop);
      index = stop;
      continue;
    }

    if (/[A-Za-z_]/.test(char)) {
      let end = index;
      while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) {
        end += 1;
      }
      const word = sql.slice(index, end);
      result += word === from ? to : word;
      index = end;
      continue;
    }

    result += char;
    index += 1;
  }

  return result;
}

/**
 * No rows, or one row of aggregates over nothing: COUNT(*) gives 0 and SUM or
 * AVG give null when the filter matched no rows, so a wrong filter value in an
 * aggregate query does not come back empty.
 */
export function looksEmpty(rows: Array<Record<string, unknown>>): boolean {
  if (rows.length === 0) return true;
  if (rows.length > 1) return false;
  const values = Object.values(rows[0]);
  return values.length > 0 && values.every((value) => value === null || value === 0 || value === "0");
}

/** A result already checked once (cached or from memory) is not checked again. */
function shouldVerify(state: State): boolean {
  return VERIFY_RESULTS && !state.sqlFromCache && state.verifyRetries === 0;
}

/**
 * Where a confirmed empty result goes. With web search on it is reviewed too,
 * since the answer may exist publicly; otherwise straight to the answer.
 */
export function afterEmptyResult(state: State): "verify" | "accept" {
  return webSearchConfigured() && shouldVerify(state) && !state.webQuery ? "verify" : "accept";
}

/**
 * Runs the current SQL and decides where the run goes next: a free identifier
 * fix, a model repair, a check of the filtered values when nothing came back,
 * a review of the result, or straight to the answer.
 */
export async function execute(state: State, config: NodeConfig) {
  const { request, step } = runtime(config, "execute");
  const sql = state.sql;
  const steps = [step(state.generations > 1 || state.freeRepairs > 0 ? "Running the corrected query..." : "Executing SQL against the selected database...")];
  const attemptNumber = state.generations + state.freeRepairs;

  if (state.wantsVisualization && state.visualizationRequest) {
    const plausibility = assessVisualizationSqlDraft({ sql, visualizationRequest: state.visualizationRequest });
    if (!plausibility.ok) {
      return retryOrGiveUp(
        state,
        { sql, issues: plausibility.errors },
        {
          steps,
          repairHistory: [{ stage: "sql_plausibility", attempt: attemptNumber, sql, errors: plausibility.errors }],
          visualizationValidationStatus: "invalid",
          visualizationValidationErrors: plausibility.errors,
          narrowedVisualizationReason: "The SQL draft was missing requested visualization fields.",
        },
        "I couldn't produce SQL for this visualization that preserved all requested fields. Please narrow the request or rephrase it.",
      );
    }
  }

  let result;
  try {
    result = await executeReadOnlyQuery(request.database, sql);
  } catch (error) {
    const dbError = normalizeDbError(error);
    const schemaIndex = getSchemaIndex(request.knowledge, request.database.schemaFingerprint);
    const missing = dbError.missingIdentifier ? bareIdentifier(dbError.missingIdentifier) : null;
    const suggestions = missing
      ? dbError.kind === "undefined_table"
        ? schemaIndex.suggestTables(missing)
        : schemaIndex.suggestColumns(missing)
      : [];
    const failure = {
      stage: "sql_execution",
      attempt: attemptNumber,
      sql,
      error: dbError.message,
      code: dbError.code,
      kind: dbError.kind,
      hint: dbError.hint,
      position: dbError.position,
      missingIdentifier: dbError.missingIdentifier,
      suggestions,
    };

    // A misspelled identifier is a string edit, not a reasoning problem. When
    // the catalog has one clear near-match, rewrite it and run again without a
    // model call.
    const fixed = state.freeRepairs < MAX_FREE_REPAIRS && missing ? applyFreeIdentifierRepair(sql, dbError, schemaIndex) : null;
    if (fixed) {
      const noun = dbError.kind === "undefined_table" ? "table" : "column";
      return new Command({
        goto: "execute",
        update: {
          sql: fixed.sql,
          freeRepairs: state.freeRepairs + 1,
          steps: [...steps, step(`Retrying with ${fixed.to} after the database reported an unknown ${noun} "${fixed.from}".`)],
          repairHistory: [failure, { stage: "sql_identifier_autocorrect", attempt: attemptNumber, from: fixed.from, to: fixed.to, sql: fixed.sql }],
          schemaCorrections: [{ from: fixed.from, to: fixed.to, stage: "sql_execution" }],
        } satisfies Update,
      });
    }

    return retryOrGiveUp(
      state,
      { sql, issues: [dbError.message], dbErrorBlock: describeDbErrorForPrompt(dbError, schemaIndex, sql) },
      { steps, repairHistory: [failure] },
      `I wasn't able to generate valid SQL for this question. The last error was: ${dbError.message}. Please try rephrasing your question.`,
    );
  }

  const update: Update = {
    rows: result.rows,
    columns: result.columns,
    rowCount: result.rowCount,
    steps,
    // Every attempt is kept for the trace; only the accepted query is recorded
    // as "sql_execution", which is what query memory learns from.
    toolCalls: [{ tool: "sql_attempt", sql, rowCount: result.rowCount }],
  };

  if (state.wantsVisualization && state.visualizationRequest) {
    const validation = validateVisualizationResult({
      request: state.visualizationRequest,
      capabilityDecision: state.visualizationCapabilityDecision ?? decideVisualizationCapability(state.visualizationRequest),
      columns: result.columns,
      rows: result.rows,
    });
    Object.assign(update, {
      visualizationValidationStatus: validation.status,
      visualizationValidationErrors: validation.errors,
      visualizationValidationNarrowedFrom: validation.narrowedFrom,
      visualizationValidationDroppedFields: validation.droppedFields,
    });

    if (validation.status === "narrowed") {
      const reason = validation.errors[0] ?? state.visualizationCapabilityDecision?.reason ?? null;
      return new Command({
        goto: "accept",
        update: {
          ...update,
          answer: buildVisualizationNarrowingAnswer({ request: state.visualizationRequest, reason, validation }),
          narrowedVisualizationReason: reason ?? "The requested visual needed narrowing after result validation.",
          repairHistory: [{ stage: "visualization_result_validation", attempt: attemptNumber, sql, errors: validation.errors, droppedFields: validation.droppedFields }],
        },
      });
    }

    if (validation.status === "invalid") {
      return retryOrGiveUp(
        state,
        { sql, issues: [`The result shape was invalid for the visualization: ${validation.errors.join(" ")}`] },
        {
          ...update,
          repairHistory: [{ stage: "visualization_result_validation", attempt: attemptNumber, sql, errors: validation.errors, droppedFields: validation.droppedFields }],
          narrowedVisualizationReason: "The executed query returned a result shape that dropped requested visualization fields.",
        },
        "I couldn't produce a visualization-ready result that preserved all requested fields. Please narrow the request or rephrase it.",
      );
    }
  }

  if (looksEmpty(result.rows) && !state.valuesChecked) {
    return new Command({ goto: "checkValues", update });
  }
  if (result.rowCount > 0 && shouldVerify(state)) {
    return new Command({ goto: "verify", update });
  }
  return new Command({ goto: result.rowCount > 0 ? "accept" : afterEmptyResult(state), update });
}
