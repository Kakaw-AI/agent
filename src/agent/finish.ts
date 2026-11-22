import { buildFallbackChartSpec, planChartSpecDeterministically } from "../graph/chart-spec.js";
import { buildNoRowsAnswer } from "../llm/answers.js";
import { setCachedPlan } from "../llm/cache.js";
import { shouldAutoPlanChart } from "../llm/intent/chart-planning.js";
import { invokeStream, invokeStructured } from "../llm/invoke.js";
import { ChartPlanSchema, SuggestionsSchema } from "../llm/schemas.js";
import { AnswerPromptBuilder } from "../prompts/AnswerPromptBuilder.js";
import { ChartPlanPromptBuilder } from "../prompts/ChartPlanPromptBuilder.js";
import { SuggestionsPromptBuilder } from "../prompts/SuggestionsPromptBuilder.js";
import { WebAnswerPromptBuilder } from "../prompts/WebAnswerPromptBuilder.js";
import { searchWeb, type WebSource } from "../net/web-search.js";
import type {
  AgentRunRequest,
  AgentStreamEvent,
  TraceAnalyticsOutcome,
  VisualizationOutcome,
} from "../types.js";
import { toReadableLabel } from "../utils/text.js";
import { type NodeConfig, runtime, type State, type Update } from "./state.js";

function resultEvents(state: State): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  if (state.sql) {
    events.push({ type: "sql_generated", data: { sql: state.sql } });
  }
  if (state.rows.length > 0 || state.columns.length > 0) {
    events.push({ type: "sql_result", data: { rowCount: state.rowCount, columns: state.columns, rows: state.rows } });
  }
  return events;
}

/**
 * The result is final. The SQL and the table go to the client now, so they
 * render while the answer is still being written rather than after it.
 */
export async function accept(state: State, config: NodeConfig): Promise<Update> {
  const { emit } = runtime(config, "accept");
  for (const event of resultEvents(state)) emit(event);

  return {
    published: true,
    // The query that produced the answer. Recorded here and only here, so
    // query memory never learns from an attempt that was later rejected.
    // A web-assisted answer is not reusable from the SQL alone, so query memory
    // does not learn it either.
    toolCalls:
      state.kind === "chart_previous" || !state.sql || state.webQuery
        ? []
        : [{ tool: "sql_execution", sql: state.sql, rowCount: state.rowCount }],
  };
}

export async function answer(state: State, config: NodeConfig): Promise<Update> {
  const { request, emit, step, hooks, signal } = runtime(config, "answer");

  // Already written: a narrowed visualization explains itself.
  if (state.answer.trim()) {
    return {};
  }

  const steps: Array<{ text: string; at: string }> = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  let sources: WebSource[] = [];
  if (state.webQuery) {
    steps.push(step(`Searching the web for "${state.webQuery}"...`));
    try {
      sources = await searchWeb(state.webQuery, signal);
      toolCalls.push({ tool: "web_search", query: state.webQuery, results: sources.length });
    } catch (error) {
      if (signal?.aborted) throw error;
      toolCalls.push({ tool: "web_search", query: state.webQuery, error: error instanceof Error ? error.message : String(error) });
    }
    if (sources.length > 0) {
      emit({ type: "web_sources", data: { sources: sources.map(({ title, url }) => ({ title, url })) } });
    }
  }

  if (sources.length > 0) {
    steps.push(step(state.rows.length > 0 ? "Writing the response from query and web results..." : "Writing the response from web results..."));
    const { content, tokenUsage } = await invokeStream({
      llm: request.llm,
      ...new WebAnswerPromptBuilder().build({
        question: state.question,
        columns: state.columns,
        rows: state.rows,
        rowCount: state.rowCount,
        sources,
      }),
      history: request.history,
      name: "write_web_answer",
      light: true,
      temperature: 0.2,
      signal,
      ...hooks,
      onDelta: (delta) => emit({ type: "message_delta", data: { messageId: request.messageId, delta } }),
    });
    return { answer: content, tokenUsage, steps, toolCalls, webSources: sources };
  }

  if (state.rows.length === 0) {
    if (!state.sql) {
      return {
        answer: "I couldn't find this on the web just now, and it isn't something your database can answer. Please try again or rephrase the question.",
        steps: [...steps, step("The web search returned nothing usable.")],
        toolCalls,
      };
    }
    return {
      answer: buildNoRowsAnswer({ question: state.question, sql: state.sql }),
      steps: [...steps, step("The query completed, but no matching rows were found.")],
      toolCalls,
    };
  }

  steps.push(step("Writing the response from query results..."));
  const { content, tokenUsage } = await invokeStream({
    llm: request.llm,
    ...new AnswerPromptBuilder().build({
      question: state.question,
      columns: state.columns,
      rows: state.rows,
      rowCount: state.rowCount,
    }),
    history: request.history,
    name: "write_answer",
    light: true,
    temperature: 0.2,
    signal,
    ...hooks,
    onDelta: (delta) => emit({ type: "message_delta", data: { messageId: request.messageId, delta } }),
  });

  return { answer: content, tokenUsage, steps, toolCalls };
}

export async function chart(state: State, config: NodeConfig): Promise<Update> {
  const { request, step, hooks, signal } = runtime(config, "chart");

  if (
    state.rows.length === 0 ||
    state.visualizationValidationStatus === "invalid" ||
    state.visualizationValidationStatus === "narrowed"
  ) {
    return {};
  }

  const autoChartAllowed =
    state.wantsVisualization || shouldAutoPlanChart({ question: state.question, columns: state.columns, rows: state.rows });
  const numericColumns = state.columns.filter((column) => state.rows.some((row) => typeof row[column] === "number"));
  if (!autoChartAllowed || numericColumns.length === 0) {
    return {};
  }

  const steps = [step("Planning a D3 visualization...")];
  const deterministic = planChartSpecDeterministically({
    question: state.question,
    columns: state.columns,
    rows: state.rows,
    visualizationRequest: state.visualizationRequest,
  });

  if (deterministic) {
    return {
      chartSpec: deterministic,
      steps,
      toolCalls: [
        {
          tool: "chart_planning",
          kind: deterministic.kind,
          xField: deterministic.xField,
          yField: deterministic.yField,
          seriesField: deterministic.seriesField ?? null,
          stacked: deterministic.stacked ?? false,
          planner: "deterministic",
        },
      ],
    };
  }

  const fallback = () => buildFallbackChartSpec({ question: state.question, columns: state.columns, rows: state.rows });
  try {
    const { value, tokenUsage } = await invokeStructured({
      llm: request.llm,
      ...new ChartPlanPromptBuilder().build({
        question: state.question,
        columns: state.columns,
        numericColumns,
        labelColumns: state.columns.filter((column) => state.rows.some((row) => typeof row[column] === "string")),
        rows: state.rows,
      }),
      name: "plan_chart",
      light: true,
      temperature: 0.1,
      signal,
      ...hooks,
      schema: ChartPlanSchema,
    });

    const yField = value.kind === "histogram" ? value.xField : value.yField;
    if (!state.columns.includes(value.xField) || !state.columns.includes(yField)) {
      return { chartSpec: fallback(), tokenUsage, steps };
    }

    return {
      chartSpec: {
        kind: value.kind,
        title: value.title,
        xField: value.xField,
        yField,
        xLabel: toReadableLabel(value.xField),
        yLabel: toReadableLabel(yField),
        data: state.rows.slice(0, 20),
      },
      tokenUsage,
      steps,
      toolCalls: [{ tool: "chart_planning", kind: value.kind, xField: value.xField, yField, planner: "llm_fallback" }],
    };
  } catch {
    return { chartSpec: fallback(), steps };
  }
}

export async function suggestions(state: State, config: NodeConfig): Promise<Update> {
  const { request, hooks, signal } = runtime(config, "suggestions");
  if (state.rows.length === 0) {
    return {};
  }

  try {
    // Deliberately without conversation history: follow-ups must be grounded
    // in the current result, not drift toward earlier turns.
    const { value, tokenUsage } = await invokeStructured({
      llm: request.llm,
      ...new SuggestionsPromptBuilder().build({
        question: state.question,
        columns: state.columns,
        rows: state.rows,
        rowCount: state.rowCount,
        tableNames: request.knowledge.tables.map((table) => table.name).join(", "),
        summary: request.knowledge.summary,
      }),
      name: "suggest_follow_ups",
      light: true,
      temperature: 0.5,
      signal,
      ...hooks,
      schema: SuggestionsSchema,
    });
    return {
      tokenUsage,
      suggestions: value.suggestions.filter((item) => typeof item === "string" && item.trim()).slice(0, 3),
    };
  } catch {
    return {};
  }
}

function buildVisualizationOutcome(state: State): VisualizationOutcome | null {
  if (
    !state.visualizationRequest &&
    !state.visualizationCapabilityDecision &&
    state.visualizationValidationStatus === "pending" &&
    !state.narrowedVisualizationReason
  ) {
    return null;
  }

  return {
    request: state.visualizationRequest ?? {
      categoryFields: [],
      metricField: null,
      seriesField: null,
      groupField: null,
      networkViewRequested: false,
    },
    capabilityDecision: state.visualizationCapabilityDecision ?? null,
    validation:
      state.visualizationValidationStatus === "pending"
        ? null
        : {
            status: state.visualizationValidationStatus,
            errors: state.visualizationValidationErrors,
            narrowedFrom: state.visualizationValidationNarrowedFrom,
            droppedFields: state.visualizationValidationDroppedFields,
          },
    narrowingReason: state.narrowedVisualizationReason,
  };
}

function analyticsOutcome(state: State, visualization: VisualizationOutcome | null): TraceAnalyticsOutcome {
  if (state.clarification) return "clarification";
  if (state.errorMessage || !state.answer) return "failed";
  if (visualization?.validation?.status === "narrowed") return "narrowed";
  if (state.chartSpec) return "chart_rendered";
  if (state.sql && state.rowCount === 0) return "no_rows";
  return "completed_text";
}

export function terminalEvents(request: AgentRunRequest, state: State): AgentStreamEvent[] {
  const visualization = buildVisualizationOutcome(state);
  const outcome = analyticsOutcome(state, visualization);
  const events: AgentStreamEvent[] = state.published ? [] : resultEvents(state);

  const trace: AgentStreamEvent = {
    type: "agent_trace",
    data: {
      steps: state.steps,
      toolCalls: state.toolCalls,
      repairHistory: state.repairHistory,
      cacheKey: state.cacheKey,
      cacheHit: state.cacheHit,
      chartSpec: state.chartSpec ?? undefined,
      visualizationOutcome: visualization,
      analyticsOutcome: outcome,
      rowCount: state.rowCount,
      standaloneQuestion: state.question || undefined,
    },
  };

  if (state.chartSpec && visualization?.validation?.status !== "narrowed") {
    events.push({
      type: "chart_generated",
      data: {
        chartType: String(state.chartSpec.kind ?? "chart"),
        title: typeof state.chartSpec.title === "string" ? state.chartSpec.title : undefined,
        spec: state.chartSpec,
        visualizationOutcome: visualization,
      },
    });
  }

  if (state.errorMessage || !state.answer) {
    const message = state.errorMessage ?? "Agent runtime did not produce an answer.";
    events.push(trace, {
      type: "message_failed",
      data: {
        messageId: request.messageId,
        error: message,
        errorInfo: state.errorMessage
          ? { message, code: "AGENT_SQL_GENERATION_FAILED", statusCode: 502, retryable: false, metadata: { raw: message } }
          : { message, code: "AGENT_RUNTIME_ERROR", statusCode: 500, retryable: false },
      },
    });
    return events;
  }

  events.push({
    type: "message_completed",
    data: {
      messageId: request.messageId,
      content: state.answer,
      tokenUsage: state.tokenUsage ?? undefined,
      visualizationOutcome: visualization,
      analyticsOutcome: outcome,
    },
  });

  // A clarification's options are offered as clickable follow-ups: picking
  // one sends it as the next message, which needs no new client UI.
  const offered = state.clarification ? state.clarification.options : state.suggestions;
  if (offered.length > 0) {
    events.push({ type: "suggestions_generated", data: { messageId: request.messageId, suggestions: offered } });
  }

  events.push(trace);
  return events;
}

/** Sends the closing events and stores a successful plan for reuse. */
export async function finalize(state: State, config: NodeConfig): Promise<Update> {
  const { request, emit } = runtime(config, "finalize");
  for (const event of terminalEvents(request, state)) emit(event);

  // `published` means the result was accepted. A run that gave up still has its
  // last failing SQL in state, and the old pipeline cached exactly that.
  if (
    state.published &&
    state.cacheKey &&
    !state.cacheHit &&
    !state.sqlFromCache &&
    !state.errorMessage &&
    !state.clarification &&
    !state.webQuery &&
    state.sql &&
    state.answer
  ) {
    setCachedPlan(state.cacheKey, {
      sql: state.sql,
      chartSpec: state.chartSpec ?? null,
      answer: state.answer,
      suggestions: state.suggestions,
      rows: state.rows,
      columns: state.columns,
      rowCount: state.rowCount,
    });
  }

  return {};
}
