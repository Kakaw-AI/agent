import {
  bareIdentifier,
  describeDbErrorForPrompt,
  normalizeDbError,
  type NormalizedDbError,
} from "../../database/db-error.js";
import { IDENTIFIER_THRESHOLDS } from "../../database/identifier-match.js";
import { executeReadOnlyQuery } from "../../database/query.js";
import { getSchemaIndex, type SchemaIndex } from "../../database/schema-index.js";
import { assessVisualizationSqlDraft } from "../../graph/qa/assessment.js";
import {
  buildVisualizationNarrowingAnswer,
  decideVisualizationCapability,
  validateVisualizationResult,
} from "../../graph/visualization.js";
import { invokeJson } from "../../llm/invoke.js";
import { SqlResponseSchema } from "../../llm/schemas.js";
import type { GraphStateValue } from "../../llm/state.js";
import { VisualizationSqlUserPromptBuilder } from "../../prompts/VisualizationSqlUserPromptBuilder.js";
import type { AgentRunRequest } from "../../types.js";
import { AgentLayer } from "../AgentLayer.js";
import type { LayerContext } from "../AgentLayer.js";
import { createSqlPromptBuilder } from "./shared.js";

/**
 * Rewrites an identifier the database rejected, when the catalog offers one
 * clearly better candidate.
 *
 * Only whole-word, unquoted occurrences are touched: a quoted identifier was
 * written deliberately and is case-sensitive in Postgres, and rewriting inside
 * a string literal would silently change what the query means. Returns null
 * whenever the match is weak, contested, or unsafe to splice.
 */
function applyFreeIdentifierRepair(
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

  const replacement =
    "column" in resolution ? resolution.column.name : resolution.table.name;

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
function replaceUnquotedIdentifier(
  sql: string,
  from: string,
  to: string,
): string {
  let result = "";
  let index = 0;

  while (index < sql.length) {
    const char = sql[index];

    if (char === "'" || char === '"' || char === "`") {
      const closing = char;
      let end = index + 1;
      while (end < sql.length) {
        if (sql[end] === closing) {
          if (sql[end + 1] === closing) {
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

export class SqlExecutionLayer extends AgentLayer {
  readonly name = "executeSql";

  shouldSkip(state: GraphStateValue): boolean {
    return (
      state.cacheHit ||
      state.intentKind === "small_talk" ||
      (state.intentKind === "visualization_followup" && state.rows.length > 0) ||
      !!state.errorMessage ||
      !state.sql
    );
  }

  async execute(request: AgentRunRequest, state: GraphStateValue, ctx: LayerContext): Promise<Partial<GraphStateValue>> {
    const sqlPromptBuilder = createSqlPromptBuilder(request.database.provider);
    const userPromptBuilder = new VisualizationSqlUserPromptBuilder();
    const schemaIndex = getSchemaIndex(
      request.knowledge,
      request.database.schemaFingerprint,
    );
    let sql = state.sql;
    const repairHistory: Array<Record<string, unknown>> = [];
    const schemaCorrections: Array<{ from: string; to: string; stage: string }> = [];

    // Attempts that cost an LLM call. Free in-process identifier repairs are
    // budgeted separately so a typo fix never eats one of them, while still
    // being bounded against a rewrite loop.
    const MAX_ATTEMPTS = 3;
    const MAX_FREE_REPAIRS = 2;
    let attempt = 0;
    let freeRepairs = 0;

    while (attempt < MAX_ATTEMPTS) {
      const attemptLabel = attempt === 0
        ? "Executing SQL against the selected database..."
        : `Repairing and retrying SQL execution (attempt ${attempt + 1}/${MAX_ATTEMPTS})...`;

      ctx.emit({ type: "agent_step", data: { text: attemptLabel, at: new Date().toISOString() } });

      const plausibility = assessVisualizationSqlDraft({
        sql,
        visualizationRequest: state.wantsVisualization ? state.visualizationRequest : null,
      });

      if (!plausibility.ok) {
        repairHistory.push({ stage: "sql_plausibility", attempt: attempt + 1, sql, errors: plausibility.errors });

        if (attempt === MAX_ATTEMPTS - 1) {
          return {
            sql,
            rowCount: 0,
            rows: [],
            columns: [],
            answer: "I couldn't produce SQL for this visualization that preserved all requested fields. Please narrow the request or rephrase it.",
            repairHistory,
            visualizationValidationStatus: "invalid",
            visualizationValidationErrors: plausibility.errors,
            narrowedVisualizationReason: "The SQL draft was missing requested visualization fields.",
            steps: [{ text: "Stopped before execution because the SQL draft dropped requested visualization fields.", at: new Date().toISOString() }],
          };
        }

        const repaired = await invokeJson({
          llm: request.llm,
          systemPrompt: sqlPromptBuilder.build({
            knowledge: request.knowledge,
            repair: { sql, error: plausibility.errors.join(" ") },
            options: {
              wantsVisualization: state.wantsVisualization,
              needsImplicitCountMetric: state.needsImplicitCountMetric,
              visualizationRequest: state.visualizationRequest,
            },
          }),
          userPrompt: userPromptBuilder.build({
            question: request.message,
            visualizationRequest: state.visualizationRequest,
            needsImplicitCountMetric: state.needsImplicitCountMetric,
            priorSql: sql,
            priorErrors: plausibility.errors,
          }),
          history: request.history,
          temperature: 0.1,
          onLlmCall: ctx.onLlmCall,
          onLlmResponse: ctx.onLlmResponse,
          schema: SqlResponseSchema,
        });
        sql = repaired.value.sql.trim();
        attempt += 1;
        continue;
      }

      try {
        const result = await executeReadOnlyQuery(request.database, sql);
        const validation =
          state.wantsVisualization && state.visualizationRequest
            ? validateVisualizationResult({
                request: state.visualizationRequest,
                capabilityDecision:
                  state.visualizationCapabilityDecision ??
                  decideVisualizationCapability(state.visualizationRequest),
                columns: result.columns,
                rows: result.rows,
              })
            : null;

        if (validation && validation.status !== "valid") {
          repairHistory.push({
            stage: "visualization_result_validation",
            attempt: attempt + 1,
            sql,
            errors: validation.errors,
            droppedFields: validation.droppedFields,
          });

          if (validation.status === "narrowed") {
            return {
              sql,
              rowCount: result.rowCount,
              rows: result.rows,
              columns: result.columns,
              answer: buildVisualizationNarrowingAnswer({
                request: state.visualizationRequest,
                reason: validation.errors[0] ?? state.visualizationCapabilityDecision?.reason ?? null,
                validation,
              }),
              repairHistory,
              visualizationValidationStatus: validation.status,
              visualizationValidationErrors: validation.errors,
              visualizationValidationNarrowedFrom: validation.narrowedFrom,
              visualizationValidationDroppedFields: validation.droppedFields,
              narrowedVisualizationReason:
                validation.errors[0] ??
                state.visualizationCapabilityDecision?.reason ??
                "The requested visual needed narrowing after result validation.",
              steps: [{ text: "Executed SQL, then narrowed the visualization because the result shape was unsupported for rendering.", at: new Date().toISOString() }],
              toolCalls: [{ tool: "sql_execution", sql, rowCount: result.rowCount }],
            };
          }

          if (attempt === MAX_ATTEMPTS - 1) {
            return {
              sql,
              rowCount: 0,
              rows: [],
              columns: [],
              answer: "I couldn't produce a visualization-ready result that preserved all requested fields. Please narrow the request or rephrase it.",
              repairHistory,
              visualizationValidationStatus: validation.status,
              visualizationValidationErrors: validation.errors,
              visualizationValidationNarrowedFrom: validation.narrowedFrom,
              visualizationValidationDroppedFields: validation.droppedFields,
              narrowedVisualizationReason: "The executed query returned a result shape that dropped requested visualization fields.",
              steps: [{ text: "Executed SQL, but the result shape did not satisfy the requested visualization fields.", at: new Date().toISOString() }],
            };
          }

          const repaired = await invokeJson({
            llm: request.llm,
            systemPrompt: sqlPromptBuilder.build({
              knowledge: request.knowledge,
              repair: {
                sql,
                error: `The result shape was invalid for the visualization: ${validation.errors.join(" ")}`,
              },
              options: {
                wantsVisualization: state.wantsVisualization,
                needsImplicitCountMetric: state.needsImplicitCountMetric,
                visualizationRequest: state.visualizationRequest,
              },
            }),
            userPrompt: userPromptBuilder.build({
              question: request.message,
              visualizationRequest: state.visualizationRequest,
              needsImplicitCountMetric: state.needsImplicitCountMetric,
              priorSql: sql,
              priorErrors: validation.errors,
            }),
            history: request.history,
            temperature: 0.1,
            onLlmCall: ctx.onLlmCall,
            onLlmResponse: ctx.onLlmResponse,
            schema: SqlResponseSchema,
          });
          sql = repaired.value.sql.trim();
          attempt += 1;
          continue;
        }

        return {
          sql,
          rowCount: result.rowCount,
          rows: result.rows,
          columns: result.columns,
          visualizationValidationStatus: validation?.status ?? state.visualizationValidationStatus,
          visualizationValidationErrors: validation?.errors ?? [],
          visualizationValidationNarrowedFrom: validation?.narrowedFrom ?? [],
          visualizationValidationDroppedFields: validation?.droppedFields ?? [],
          steps: [{ text: "Executing SQL against the selected database...", at: new Date().toISOString() }],
          toolCalls: [{ tool: "sql_execution", sql, rowCount: result.rowCount }],
          repairHistory,
          // `sql` is the corrected text, so the plan cache stores the query that
          // actually worked rather than the one that failed.
          schemaCorrections,
        };
      } catch (error) {
        const dbError = normalizeDbError(error);
        const message = dbError.message;
        const bareMissing = dbError.missingIdentifier
          ? bareIdentifier(dbError.missingIdentifier)
          : null;
        const suggestions = bareMissing
          ? dbError.kind === "undefined_table"
            ? schemaIndex.suggestTables(bareMissing)
            : schemaIndex.suggestColumns(bareMissing)
          : [];

        repairHistory.push({
          stage: "sql_execution",
          attempt: attempt + 1,
          sql,
          error: message,
          code: dbError.code,
          kind: dbError.kind,
          hint: dbError.hint,
          position: dbError.position,
          missingIdentifier: dbError.missingIdentifier,
          suggestions,
        });

        // A misspelled identifier is a string edit, not a reasoning problem. If
        // the catalog has an unambiguous near-match we rewrite it in place and
        // retry, which turns the most common runtime failure from a full repair
        // round-trip into no LLM call at all.
        if (freeRepairs < MAX_FREE_REPAIRS && bareMissing) {
          const corrected = applyFreeIdentifierRepair(sql, dbError, schemaIndex);
          if (corrected) {
            freeRepairs += 1;
            repairHistory.push({
              stage: "sql_identifier_autocorrect",
              attempt: attempt + 1,
              from: corrected.from,
              to: corrected.to,
              sql: corrected.sql,
            });
            ctx.emit({
              type: "agent_step",
              data: {
                text: `Retrying with ${corrected.to} after the database reported an unknown ${dbError.kind === "undefined_table" ? "table" : "column"} "${corrected.from}".`,
                at: new Date().toISOString(),
              },
            });
            schemaCorrections.push({
              from: corrected.from,
              to: corrected.to,
              stage: "sql_execution",
            });
            sql = corrected.sql;
            continue;
          }
        }

        attempt += 1;

        if (attempt >= MAX_ATTEMPTS) {
          return {
            sql,
            rowCount: 0,
            rows: [],
            columns: [],
            answer: `I wasn't able to generate valid SQL for this question after ${MAX_ATTEMPTS} attempts. The last error was: ${message}. Please try rephrasing your question.`,
            repairHistory,
            schemaCorrections,
            steps: [{ text: `SQL execution failed after ${MAX_ATTEMPTS} attempts.`, at: new Date().toISOString() }],
          };
        }

        const repaired = await invokeJson({
          llm: request.llm,
          systemPrompt: sqlPromptBuilder.build({
            knowledge: request.knowledge,
            repair: { sql, error: message },
            options: {
              wantsVisualization: state.wantsVisualization,
              needsImplicitCountMetric: state.needsImplicitCountMetric,
              visualizationRequest: state.visualizationRequest,
            },
          }),
          // Previously a bare "Original question: ..." string, which dropped the
          // failing SQL and every prior error from this branch alone.
          userPrompt: userPromptBuilder.build({
            question: request.message,
            visualizationRequest: state.visualizationRequest,
            needsImplicitCountMetric: state.needsImplicitCountMetric,
            priorSql: sql,
            priorErrors: [message],
            dbErrorBlock: describeDbErrorForPrompt(dbError, schemaIndex, sql),
          }),
          history: request.history,
          temperature: 0.1,
          onLlmCall: ctx.onLlmCall,
          onLlmResponse: ctx.onLlmResponse,
          schema: SqlResponseSchema,
        });
        sql = repaired.value.sql.trim();
      }
    }

    return {
      sql,
      rowCount: 0,
      rows: [],
      columns: [],
      answer: `I wasn't able to execute valid SQL for this question after ${MAX_ATTEMPTS} attempts. Please try rephrasing your question.`,
      repairHistory,
      schemaCorrections,
      steps: [{ text: `SQL execution failed after ${MAX_ATTEMPTS} attempts.`, at: new Date().toISOString() }],
    };
  }
}
