import { executeReadOnlyQuery } from "../../database/query.js";
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
    let sql = state.sql;
    const repairHistory: Array<Record<string, unknown>> = [];
    const MAX_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
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
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : "SQL execution failed.";
        repairHistory.push({ stage: "sql_execution", attempt: attempt + 1, sql, error: message });

        if (attempt === MAX_ATTEMPTS - 1) {
          return {
            sql,
            rowCount: 0,
            rows: [],
            columns: [],
            answer: `I wasn't able to generate valid SQL for this question after ${MAX_ATTEMPTS} attempts. The last error was: ${message}. Please try rephrasing your question.`,
            repairHistory,
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
          userPrompt: `Original question: ${request.message}`,
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
      steps: [{ text: `SQL execution failed after ${MAX_ATTEMPTS} attempts.`, at: new Date().toISOString() }],
    };
  }
}
