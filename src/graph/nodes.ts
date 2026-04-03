import { LruCache } from "../cache.js";
import { invokeJson, invokeText } from "../llm/index.js";
import { executeReadOnlyQuery } from "../database/index.js";
import { buildCacheKey, buildSqlSystemPrompt, buildSqlRepairPrompt } from "./prompts.js";
import type { GraphStateValue } from "./state.js";
import type { AgentRunRequest, TokenUsage } from "../types.js";

export const responseCache = new LruCache<{
  sql: string;
  rows: Array<Record<string, unknown>>;
  columns: string[];
  answer: string;
  chartSpec: Record<string, unknown> | null;
  suggestions: string[];
}>(200, 5 * 60 * 1000);

export async function loadCacheNode(request: AgentRunRequest, _state: GraphStateValue) {
  const cacheKey = buildCacheKey(request);
  const cached = responseCache.get(cacheKey);
  if (!cached) {
    return {
      cacheKey,
      steps: [{ text: "Loading indexed schema context...", at: new Date().toISOString() }],
    };
  }

  return {
    cacheKey,
    cacheHit: true,
    sql: cached.sql,
    rows: cached.rows,
    columns: cached.columns,
    answer: cached.answer,
    chartSpec: cached.chartSpec,
    suggestions: cached.suggestions,
    steps: [{ text: "Using cached answer for a repeated question...", at: new Date().toISOString() }],
  };
}

export async function generateSqlNode(request: AgentRunRequest, state: GraphStateValue) {
  if (state.cacheHit) {
    return {};
  }

  let value: { sql: string; rationale?: string };
  let tokenUsage: TokenUsage | null;
  try {
    const result = await invokeJson<{ sql: string; rationale?: string }>({
      llm: request.llm,
      systemPrompt: buildSqlSystemPrompt(request.knowledge),
      userPrompt: `Question: ${request.message}`,
      history: request.history,
      temperature: 0.1,
    });
    value = result.value;
    tokenUsage = result.tokenUsage;
  } catch (err) {
    const message = err instanceof Error ? err.message : "SQL generation failed.";
    return {
      sql: "",
      steps: [{ text: `SQL generation failed: ${message}`, at: new Date().toISOString() }],
    };
  }

  return {
    sql: value.sql.trim(),
    tokenUsage,
    steps: [{ text: "Generating read-only SQL...", at: new Date().toISOString() }],
    toolCalls: [
      {
        tool: "sql_generation",
        sql: value.sql.trim(),
        rationale: value.rationale ?? null,
      },
    ],
  };
}

export async function executeSqlNode(request: AgentRunRequest, state: GraphStateValue) {
  if (state.cacheHit || !state.sql) {
    return {};
  }

  let sql = state.sql;
  const repairHistory: Array<Record<string, unknown>> = [];

  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    try {
      const result = await executeReadOnlyQuery(request.database, sql);
      return {
        sql,
        rows: result.rows,
        columns: result.columns,
        steps: [{ text: "Executing SQL against the selected database...", at: new Date().toISOString() }],
        toolCalls: [
          {
            tool: "sql_execution",
            sql,
            rowCount: result.rowCount,
          },
        ],
        repairHistory,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "SQL execution failed.";
      repairHistory.push({
        stage: "sql_execution",
        attempt: attempt + 1,
        sql,
        error: message,
      });

      if (attempt === MAX_ATTEMPTS - 1) {
        return {
          sql,
          rows: [],
          columns: [],
          answer: `I wasn't able to generate valid SQL for this question after ${MAX_ATTEMPTS} attempts. The last error was: ${message}. Please try rephrasing your question.`,
          repairHistory,
          steps: [{ text: `SQL execution failed after ${MAX_ATTEMPTS} attempts.`, at: new Date().toISOString() }],
        };
      }

      const repaired = await invokeJson<{ sql: string }>({
        llm: request.llm,
        systemPrompt: buildSqlRepairPrompt(request.knowledge, sql, message),
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
  if (state.cacheHit || state.rows.length === 0) {
    return state.cacheHit ? {} : { answer: "The query ran but returned no rows." };
  }

  const { content, tokenUsage } = await invokeText({
    llm: request.llm,
    systemPrompt:
      "You are a database analyst. Answer the user's question using only the SQL results provided. Be concise and precise.",
    userPrompt: `Question: ${request.message}\n\nColumns: ${state.columns.join(", ")}\nRows: ${JSON.stringify(
      state.rows.slice(0, 25),
    )}`,
    history: request.history,
    temperature: 0.2,
  });

  return {
    answer: content,
    tokenUsage,
    steps: [{ text: "Writing the response from query results...", at: new Date().toISOString() }],
  };
}

export async function planChartNode(request: AgentRunRequest, state: GraphStateValue) {
  if (state.cacheHit || state.rows.length === 0) {
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

  try {
    const { value } = await invokeJson<{
      kind: "bar" | "line" | "pie" | "scatter" | "histogram";
      title: string;
      xField: string;
      yField: string;
    }>({
      llm: request.llm,
      systemPrompt: [
        "You plan D3 visualizations. Pick the best chart type from: bar, line, pie, scatter, histogram.",
        "Guidelines:",
        "- bar: categorical x-axis, numeric y-axis (comparisons, rankings)",
        "- line: ordered/time x-axis, numeric y-axis (trends over time or sequence)",
        "- pie: one categorical + one numeric column, 8 or fewer categories (part-of-whole)",
        "- scatter: two numeric columns (correlation, distribution of two variables)",
        "- histogram: one numeric column, show distribution (use xField only; set yField same as xField)",
        "Use only field names that exist in the result set.",
        `Available columns: ${state.columns.join(", ")}`,
        `Numeric columns: ${numericColumns.join(", ")}`,
        `Label columns: ${labelColumns.join(", ")}`,
      ].join("\n"),
      userPrompt: `Question: ${request.message}\nRows sample: ${JSON.stringify(state.rows.slice(0, 10))}`,
      temperature: 0.1,
    });

    const xValid = state.columns.includes(value.xField);
    const yValid = value.kind === "histogram" || state.columns.includes(value.yField);
    if (!xValid || !yValid) {
      return {};
    }

    return {
      chartSpec: {
        kind: value.kind,
        title: value.title,
        xField: value.xField,
        yField: value.kind === "histogram" ? value.xField : value.yField,
        data: state.rows.slice(0, 20),
      },
      steps: [{ text: "Planning a D3 visualization...", at: new Date().toISOString() }],
      toolCalls: [
        {
          tool: "chart_planning",
          kind: value.kind,
          xField: value.xField,
          yField: value.yField,
        },
      ],
    };
  } catch {
    return {};
  }
}

export async function generateSuggestionsNode(request: AgentRunRequest, state: GraphStateValue) {
  if (state.cacheHit) {
    return {};
  }

  const tableNames = request.knowledge.tables.map((t) => t.name).join(", ");

  try {
    const { value } = await invokeJson<string[]>({
      llm: request.llm,
      systemPrompt: [
        "You are a database analyst. Given the user's question, the answer, and the database schema,",
        "suggest three short follow-up questions that CAN be answered using the available tables.",
        `Available tables: ${tableNames}`,
        "Return a JSON array of exactly 3 strings. Each suggestion must reference only the available tables.",
      ].join("\n"),
      userPrompt: `Question: ${request.message}\nAnswer: ${state.answer}\nKnowledge summary: ${request.knowledge.summary}`,
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
