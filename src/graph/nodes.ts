// agent-ts/src/graph/nodes.ts

import { executeReadOnlyQuery } from "../database/index.js";
import { buildFailurePresentation } from "../errors.js";
import { buildDirectAnswer, buildNoRowsAnswer } from "../llm/answers.js";
import { invokeJson, invokeText } from "../llm/index.js";
import { AnswerPromptBuilder } from "../prompts/AnswerPromptBuilder.js";
import { ChartPlanPromptBuilder } from "../prompts/ChartPlanPromptBuilder.js";
import type { BaseSqlPromptBuilder } from "../prompts/SqlPromptBuilder.js";
import { PostgresSqlPromptBuilder } from "../prompts/database/PostgresSqlPromptBuilder.js";
import { SqliteSqlPromptBuilder } from "../prompts/database/SqliteSqlPromptBuilder.js";
import { SuggestionsPromptBuilder } from "../prompts/SuggestionsPromptBuilder.js";
import { VisualizationSqlUserPromptBuilder } from "../prompts/VisualizationSqlUserPromptBuilder.js";
import type { AgentRunRequest, TokenUsage } from "../types.js";
import { toReadableLabel } from "../utils/text.js";
import { mergeTokenUsage } from "../utils/token.js";
import { buildFallbackChartSpec, planChartSpecDeterministically } from "./chart-spec.js";
import {
  classifyIntentHeuristically,
  collectDerivedDimensionKeys,
  needsImplicitCountMetric as shouldUseImplicitCountMetric,
  shouldAutoPlanChart,
} from "./intent.js";
import { assessVisualizationSqlDraft, buildVisualizationSqlExhaustedOutcome } from "./sql/assessment.js";
import type { GraphStateValue } from "./state.js";
import type { ChartPlanLlmResponse } from "./types.js";
import {
  buildVisualizationNarrowingAnswer,
  decideVisualizationCapability,
  validateVisualizationResult,
} from "./visualization.js";

function createSqlPromptBuilder(provider: string): BaseSqlPromptBuilder {
  if (provider === "sqlite") {
    return new SqliteSqlPromptBuilder();
  }
  return new PostgresSqlPromptBuilder();
}

export async function loadCacheNode(request: AgentRunRequest, _state: GraphStateValue) {
  return {
    steps: [{ text: "Loading indexed schema context...", at: new Date().toISOString() }],
  };
}

export async function classifyIntentNode(request: AgentRunRequest, state: GraphStateValue) {
  if (state.cacheHit) {
    return {};
  }

  const intent = classifyIntentHeuristically(request.message, request.history);
  const availableColumns = request.knowledge.tables.flatMap((table) =>
    table.columns.map((column) => column.name),
  );
  const needsImplicitCountMetric = shouldUseImplicitCountMetric(intent, availableColumns);

  if (intent.kind === "small_talk") {
    return {
      intentKind: intent.kind,
      wantsVisualization: intent.wantsVisualization,
      visualizationRequest: null,
      visualizationCapabilityDecision: null,
      needsImplicitCountMetric,
      answer: buildDirectAnswer(request.message),
      suggestions: [],
      steps: [{ text: "Responding directly without querying the database...", at: new Date().toISOString() }],
    };
  }

  return {
    intentKind: intent.kind,
    wantsVisualization: intent.wantsVisualization,
    visualizationRequest: intent.visualizationRequest,
    visualizationCapabilityDecision: decideVisualizationCapability(intent.visualizationRequest),
    needsImplicitCountMetric,
  };
}

export async function generateSqlNode(request: AgentRunRequest, state: GraphStateValue) {
  if (state.cacheHit || state.intentKind === "small_talk" || state.answer || state.errorMessage) {
    return {};
  }

  const sqlPromptBuilder = createSqlPromptBuilder(request.database.provider);
  const userPromptBuilder = new VisualizationSqlUserPromptBuilder();
  let tokenUsage: TokenUsage | null = null;
  let lastSql = "";
  let lastRationale: string | null = null;
  let priorErrors: string[] = [];
  const MAX_DRAFT_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_DRAFT_ATTEMPTS; attempt += 1) {
    try {
      const result = await invokeJson<{ sql: string; rationale?: string }>({
        llm: request.llm,
        systemPrompt: sqlPromptBuilder.build({
          knowledge: request.knowledge,
          options: {
            wantsVisualization: state.wantsVisualization,
            needsImplicitCountMetric: state.needsImplicitCountMetric,
            visualizationRequest: state.visualizationRequest,
            derivedDimensionKeys: collectDerivedDimensionKeys(
              request.message,
              state.visualizationRequest,
            ),
          },
        }),
        userPrompt: userPromptBuilder.build({
          question: request.message,
          visualizationRequest: state.visualizationRequest,
          needsImplicitCountMetric: state.needsImplicitCountMetric,
          priorSql: attempt > 0 ? lastSql : null,
          priorErrors,
        }),
        history: request.history,
        temperature: 0.1,
      });

      tokenUsage = mergeTokenUsage(tokenUsage, result.tokenUsage);
      lastSql = result.value.sql.trim();
      lastRationale = result.value.rationale ?? null;

      const assessment = assessVisualizationSqlDraft({
        sql: lastSql,
        visualizationRequest: state.wantsVisualization ? state.visualizationRequest : null,
      });

      if (assessment.ok) {
        return {
          sql: lastSql,
          tokenUsage,
          visualizationValidationStatus:
            state.wantsVisualization && state.visualizationRequest
              ? "pending"
              : state.visualizationValidationStatus,
          steps: [{ text: "Generating read-only SQL...", at: new Date().toISOString() }],
          toolCalls: [{ tool: "sql_generation", sql: lastSql, rationale: lastRationale }],
        };
      }

      priorErrors = assessment.errors;
    } catch (err) {
      const message = err instanceof Error ? err.message : "SQL generation failed.";
      const failure = buildFailurePresentation(message);
      return {
        errorMessage: message,
        publicErrorMessage: failure.publicMessage,
        steps: [{ text: failure.stepText, at: new Date().toISOString() }],
      };
    }
  }

  return buildVisualizationSqlExhaustedOutcome(priorErrors);
}

export async function executeSqlNode(request: AgentRunRequest, state: GraphStateValue) {
  if (state.cacheHit || state.intentKind === "small_talk" || state.errorMessage || !state.sql) {
    return {};
  }

  const sqlPromptBuilder = createSqlPromptBuilder(request.database.provider);
  const userPromptBuilder = new VisualizationSqlUserPromptBuilder();
  let sql = state.sql;
  const repairHistory: Array<Record<string, unknown>> = [];
  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
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

      const repaired = await invokeJson<{ sql: string }>({
        llm: request.llm,
        systemPrompt: sqlPromptBuilder.build({
          knowledge: request.knowledge,
          repair: { sql, error: plausibility.errors.join(" ") },
          options: {
            wantsVisualization: state.wantsVisualization,
            needsImplicitCountMetric: state.needsImplicitCountMetric,
            visualizationRequest: state.visualizationRequest,
            derivedDimensionKeys: collectDerivedDimensionKeys(request.message, state.visualizationRequest),
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

        const repaired = await invokeJson<{ sql: string }>({
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
              derivedDimensionKeys: collectDerivedDimensionKeys(request.message, state.visualizationRequest),
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

      const repaired = await invokeJson<{ sql: string }>({
        llm: request.llm,
        systemPrompt: sqlPromptBuilder.build({
          knowledge: request.knowledge,
          repair: { sql, error: message },
          options: {
            wantsVisualization: state.wantsVisualization,
            needsImplicitCountMetric: state.needsImplicitCountMetric,
            visualizationRequest: state.visualizationRequest,
            derivedDimensionKeys: collectDerivedDimensionKeys(request.message, state.visualizationRequest),
          },
        }),
        userPrompt: `Original question: ${request.message}`,
        history: request.history,
        temperature: 0.1,
      });
      sql = repaired.value.sql.trim();
    }
  }

  return {};
}

export async function composeAnswerNode(request: AgentRunRequest, state: GraphStateValue) {
  if (state.cacheHit || state.intentKind === "small_talk" || state.errorMessage) {
    return {};
  }

  if (typeof state.answer === "string" && state.answer.trim()) {
    return {};
  }

  if (state.rows.length === 0) {
    return {
      answer: buildNoRowsAnswer({ question: request.message, sql: state.sql }),
      steps: [{ text: "The query completed, but no matching rows were found.", at: new Date().toISOString() }],
    };
  }

  const prompt = new AnswerPromptBuilder().build({
    question: request.message,
    columns: state.columns,
    rows: state.rows,
  });

  const { content, tokenUsage } = await invokeText({
    llm: request.llm,
    ...prompt,
    history: request.history,
    temperature: 0.2,
  });

  return {
    answer: content,
    tokenUsage,
    steps: [{ text: "Writing the response from query results...", at: new Date().toISOString() }],
  };
}

export async function planChartNode(
  request: AgentRunRequest,
  state: GraphStateValue,
  deps: { invokeJsonFn?: typeof invokeJson } = {},
) {
  if (
    state.cacheHit ||
    state.rows.length === 0 ||
    state.visualizationValidationStatus === "invalid" ||
    state.visualizationValidationStatus === "narrowed"
  ) {
    return {};
  }

  const autoChartAllowed =
    state.intentKind === "explicit_visualization" ||
    state.intentKind === "visualization_followup" ||
    shouldAutoPlanChart({ question: request.message, columns: state.columns, rows: state.rows });

  if (!autoChartAllowed) {
    return {};
  }

  const numericColumns = state.columns.filter((column) =>
    state.rows.some((row) => typeof row[column] === "number"),
  );
  const labelColumns = state.columns.filter((column) =>
    state.rows.some((row) => typeof row[column] === "string"),
  );

  if (numericColumns.length === 0) {
    return {};
  }

  const deterministicChartSpec = planChartSpecDeterministically({
    question: request.message,
    columns: state.columns,
    rows: state.rows,
    visualizationRequest: state.visualizationRequest,
  });

  if (deterministicChartSpec) {
    return {
      chartSpec: deterministicChartSpec,
      steps: [{ text: "Planning a D3 visualization...", at: new Date().toISOString() }],
      toolCalls: [{
        tool: "chart_planning",
        kind: deterministicChartSpec.kind,
        xField: deterministicChartSpec.xField,
        yField: deterministicChartSpec.yField,
        seriesField: deterministicChartSpec.seriesField ?? null,
        stacked: deterministicChartSpec.stacked ?? false,
        planner: "deterministic",
      }],
    };
  }

  const prompt = new ChartPlanPromptBuilder().build({
    question: request.message,
    columns: state.columns,
    numericColumns,
    labelColumns,
    rows: state.rows,
  });

  try {
    const invokeJsonFn = deps.invokeJsonFn ?? invokeJson;
    const { value } = await invokeJsonFn<ChartPlanLlmResponse>({
      llm: request.llm,
      ...prompt,
      temperature: 0.1,
    });

    const xValid = state.columns.includes(value.xField);
    const yValid = value.kind === "histogram" || state.columns.includes(value.yField);

    if (!xValid || !yValid) {
      return {
        chartSpec: buildFallbackChartSpec({ question: request.message, columns: state.columns, rows: state.rows }),
        steps: [{ text: "Planning a D3 visualization...", at: new Date().toISOString() }],
      };
    }

    return {
      chartSpec: {
        kind: value.kind,
        title: value.title,
        xField: value.xField,
        yField: value.kind === "histogram" ? value.xField : value.yField,
        xLabel: toReadableLabel(value.xField),
        yLabel: toReadableLabel(value.kind === "histogram" ? value.xField : value.yField),
        data: state.rows.slice(0, 20),
      },
      steps: [{ text: "Planning a D3 visualization...", at: new Date().toISOString() }],
      toolCalls: [{ tool: "chart_planning", kind: value.kind, xField: value.xField, yField: value.yField, planner: "llm_fallback" }],
    };
  } catch {
    return {
      chartSpec: buildFallbackChartSpec({ question: request.message, columns: state.columns, rows: state.rows }),
      steps: [{ text: "Planning a D3 visualization...", at: new Date().toISOString() }],
    };
  }
}

export async function generateSuggestionsNode(request: AgentRunRequest, state: GraphStateValue) {
  if (state.cacheHit || state.intentKind === "small_talk" || !state.answer) {
    return {};
  }

  const prompt = new SuggestionsPromptBuilder().build({
    question: request.message,
    answer: state.answer,
    tableNames: request.knowledge.tables.map((t) => t.name).join(", "),
    summary: request.knowledge.summary,
  });

  try {
    const { value } = await invokeJson<string[]>({
      llm: request.llm,
      ...prompt,
      history: request.history,
      temperature: 0.5,
    });

    return {
      suggestions: value.filter((item) => typeof item === "string").slice(0, 3),
    };
  } catch {
    return { suggestions: [] };
  }
}
