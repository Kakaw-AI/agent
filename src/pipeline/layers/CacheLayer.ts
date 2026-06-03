import { RESULT_CACHE_STRICT } from "../../config.js";
import { computeCacheKey, getCachedPlan } from "../../llm/cache.js";
import type { GraphStateValue } from "../../llm/state.js";
import type { AgentRunRequest } from "../../types.js";
import { AgentLayer } from "../AgentLayer.js";
import type { LayerContext } from "../AgentLayer.js";

/**
 * Looks up a cached query plan for the current question/schema and short-circuits
 * the expensive SQL-generation step.
 *
 * - Default (safe) mode: reuse the cached SQL only and re-run execution +
 *   answer + suggestions so the returned data stays fresh.
 * - Strict mode (RESULT_CACHE_STRICT): reuse the full cached result and skip
 *   every downstream layer.
 *
 * Runs after IntentLayer so it can skip non-cacheable intents (small talk and
 * visualization follow-ups, which depend on prior conversation state).
 */
export class CacheLayer extends AgentLayer {
  readonly name = "cacheLookup";

  shouldSkip(state: GraphStateValue): boolean {
    return (
      state.cacheHit ||
      state.intentKind === "small_talk" ||
      state.intentKind === "visualization_followup" ||
      !!state.answer ||
      !!state.errorMessage
    );
  }

  async execute(
    request: AgentRunRequest,
    _state: GraphStateValue,
    ctx: LayerContext,
  ): Promise<Partial<GraphStateValue>> {
    const cacheKey = computeCacheKey(request);
    const cached = getCachedPlan(cacheKey);

    if (!cached) {
      return { cacheKey };
    }

    if (RESULT_CACHE_STRICT) {
      const text = "Reusing cached answer for an identical question...";
      ctx.emit({ type: "agent_step", data: { text, at: new Date().toISOString() } });
      return {
        cacheKey,
        cacheHit: true,
        sql: cached.sql,
        chartSpec: cached.chartSpec,
        answer: cached.answer,
        suggestions: cached.suggestions,
        rows: cached.rows,
        columns: cached.columns,
        rowCount: cached.rowCount,
        steps: [{ text, at: new Date().toISOString() }],
      };
    }

    const text = "Reusing cached query plan and re-running it for fresh data...";
    ctx.emit({ type: "agent_step", data: { text, at: new Date().toISOString() } });
    return {
      cacheKey,
      sqlFromCache: true,
      sql: cached.sql,
      steps: [{ text, at: new Date().toISOString() }],
    };
  }
}
