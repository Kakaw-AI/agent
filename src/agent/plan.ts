import { Command } from "@langchain/langgraph";
import { RESULT_CACHE_STRICT } from "../config.js";
import { didYouMeanFromEntries } from "../graph/field-resolution.js";
import { computeCacheKey, getCachedPlan } from "../llm/cache.js";
import { previousTurnAskedUser } from "../llm/intent/history.js";
import { invokeStructured, LlmReplyError } from "../llm/invoke.js";
import { SqlDraftSchema } from "../llm/schemas.js";
import { PostgresSqlPromptBuilder } from "../prompts/database/PostgresSqlPromptBuilder.js";
import { SqliteSqlPromptBuilder } from "../prompts/database/SqliteSqlPromptBuilder.js";
import { MongoSqlPromptBuilder } from "../prompts/database/MongoSqlPromptBuilder.js";
import { VisualizationSqlUserPromptBuilder } from "../prompts/VisualizationSqlUserPromptBuilder.js";
import { planWebQuery } from "./web.js";
import { type NodeConfig, runtime, type SqlFeedback, type State, type Update } from "./state.js";

/** SQL drafts the model may write in one run: the first plus three repairs. */
export const MAX_GENERATIONS = 4;

/**
 * Sends the run back to SQL generation with what went wrong, or ends it with
 * an explanation once the draft budget is spent. Every failure path (database
 * error, empty result, failed check) goes through here, so the budget is
 * enforced in one place.
 */
export function retryOrGiveUp(
  state: State,
  feedback: SqlFeedback,
  update: Update,
  giveUpAnswer: string,
): Command {
  if (state.generations < MAX_GENERATIONS) {
    return new Command({ goto: "generate", update: { ...update, feedback } });
  }
  return new Command({
    goto: "finalize",
    update: {
      ...update,
      rows: [],
      columns: [],
      rowCount: 0,
      answer: giveUpAnswer,
      steps: [...(Array.isArray(update.steps) ? update.steps : []), { text: `Stopped after ${MAX_GENERATIONS} attempts.`, at: new Date().toISOString() }],
    },
  });
}

/**
 * Reuses SQL this database already answered the same question with: from the
 * in-process plan cache, or from the query memory the backend looked up.
 */
export async function cache(state: State, config: NodeConfig) {
  const { request, step } = runtime(config, "cache");
  const cacheKey = computeCacheKey(request, state.question);
  const cached = getCachedPlan(cacheKey);

  if (cached && RESULT_CACHE_STRICT) {
    return new Command({
      goto: "finalize",
      update: {
        cacheKey,
        cacheHit: true,
        sql: cached.sql,
        chartSpec: cached.chartSpec,
        answer: cached.answer,
        suggestions: cached.suggestions,
        rows: cached.rows,
        columns: cached.columns,
        rowCount: cached.rowCount,
        steps: [step("Reusing cached answer for an identical question...")],
      } satisfies Update,
    });
  }

  if (cached) {
    return new Command({
      goto: "execute",
      update: {
        cacheKey,
        sqlFromCache: true,
        sql: cached.sql,
        steps: [step("Reusing cached query plan and re-running it for fresh data...")],
      } satisfies Update,
    });
  }

  // The backend matches query memory on the user's raw text. For a rewritten
  // follow-up that text ("what about Latin America?") says nothing on its own,
  // and the stored SQL may belong to a different conversation entirely.
  const exactPlan = request.retrieval?.exactPlan;
  if (exactPlan?.sql && !state.rewritten) {
    return new Command({
      goto: "execute",
      update: {
        cacheKey,
        sqlFromCache: true,
        fromMemory: true,
        sql: exactPlan.sql,
        steps: [step("Reusing a query this database has answered before...")],
        toolCalls: [{ tool: "query_memory", hit: "exact", memoryId: exactPlan.memoryId }],
      } satisfies Update,
    });
  }

  return new Command({ goto: "generate", update: { cacheKey } satisfies Update });
}

/**
 * Writes a SQL draft, or a clarifying question when the request cannot be
 * answered without a choice only the user can make. Repairs come back here with
 * `feedback` set, carrying the failed SQL and what was wrong with it.
 */
export async function generate(state: State, config: NodeConfig) {
  const { request, step, hooks, signal } = runtime(config, "generate");
  const feedback = state.feedback;
  const generations = state.generations + 1;
  const steps = [
    step(feedback ? `Rewriting the query (attempt ${generations} of ${MAX_GENERATIONS})...` : "Generating read-only SQL..."),
  ];
  const promptBuilder = new { sqlite: SqliteSqlPromptBuilder, mongodb: MongoSqlPromptBuilder, postgresql: PostgresSqlPromptBuilder }[request.database.provider]();

  let result;
  try {
    result = await invokeStructured({
      llm: request.llm,
      // The system prompt carries the schema catalog and stays byte-identical
      // between attempts so it can be served from the provider's prompt cache;
      // the failing SQL and errors travel in the user message.
      systemPrompt: promptBuilder.build({
        knowledge: request.knowledge,
        options: {
          wantsVisualization: state.wantsVisualization,
          visualizationRequest: state.visualizationRequest,
        },
        repair: feedback ? { sql: feedback.sql, error: feedback.issues.join(" ") } : undefined,
      }),
      userPrompt: new VisualizationSqlUserPromptBuilder().build({
        question: state.question,
        visualizationRequest: state.visualizationRequest,
        needsImplicitCountMetric: false,
        priorSql: feedback?.sql || null,
        priorErrors: feedback?.issues ?? [],
        dbErrorBlock: feedback?.dbErrorBlock ?? null,
        examples: request.retrieval?.examples,
        fieldSuggestions: didYouMeanFromEntries(state.fieldResolutions),
      }),
      history: request.history,
      name: feedback ? "rewrite_sql" : "generate_sql",
      temperature: 0.1,
      signal,
      ...hooks,
      schema: SqlDraftSchema,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "SQL generation failed.";
    return new Command({
      goto: "finalize",
      update: {
        errorMessage: message,
        tokenUsage: error instanceof LlmReplyError ? error.tokenUsage : null,
        steps: [...steps, { text: `Failed: ${message}`, at: new Date().toISOString() }],
      } satisfies Update,
    });
  }

  const { value, tokenUsage } = result;
  const clarifyingQuestion = value.clarifyingQuestion.trim();
  // Only on the first draft, and never twice in a row: a repair has already
  // committed to an interpretation, and a reply to our question must be answered.
  const mayAsk = !feedback && state.generations === 0 && !previousTurnAskedUser(request.history);

  if (value.needsClarification && clarifyingQuestion && mayAsk) {
    const options = value.options.map((option) => option.trim()).filter(Boolean).slice(0, 4);
    return new Command({
      goto: "finalize",
      update: {
        generations,
        tokenUsage,
        answer: clarifyingQuestion,
        clarification: { question: clarifyingQuestion, options },
        steps: [...steps, step("The question can be read more than one way; asking which one is meant.")],
        toolCalls: [{ tool: "clarification", question: clarifyingQuestion, options, rationale: value.rationale }],
      } satisfies Update,
    });
  }

  const sql = value.sql.trim();
  // A repair keeps the search the first draft asked for.
  const rawWebQuery = typeof value.webQuery === "string" ? value.webQuery : "";
  const webQuery = planWebQuery(value.needsWeb, rawWebQuery, request, state.question) || state.webQuery;
  const toolCalls: Array<Record<string, unknown>> = [{ tool: "sql_generation", sql, rationale: value.rationale }];
  if (value.needsWeb === true && rawWebQuery.trim() && !webQuery) {
    toolCalls.push({ tool: "web_search", dropped: "query contained database values" });
  }
  const update: Update = { generations, tokenUsage, steps, toolCalls, ...(webQuery ? { webQuery } : {}) };

  // Outside facts only: nothing to run against the database.
  if (!sql && webQuery) {
    return new Command({ goto: "accept", update: { ...update, sql: "", feedback: null } });
  }

  if (!sql) {
    return retryOrGiveUp(
      { ...state, generations },
      { sql: feedback?.sql ?? "", issues: ["No SQL was returned. Write the SQL query that answers the question."] },
      update,
      "I wasn't able to write a query for this question. Please try rephrasing it.",
    );
  }

  return new Command({ goto: "execute", update: { ...update, sql, feedback: null } });
}
