export const MAX_SAMPLE_ROWS = 3;
export const MAX_RESULT_ROWS = 200;
export const LLM_TIMEOUT_MS = readIntEnv("LLM_TIMEOUT_MS", 90 * 1000);

/**
 * Rows inlined into the answer prompt. The model is summarizing, not
 * transcribing — the user already sees the full table — so the whole result set
 * was pure token cost. A head sample plus computed aggregates carries the shape
 * of the data at a fraction of the size.
 */
export const MAX_ANSWER_PROMPT_ROWS = readIntEnv("MAX_ANSWER_PROMPT_ROWS", 20);

/** Prior turns replayed to the model, and result rows kept per replayed turn. */
export const MAX_HISTORY_MESSAGES = readIntEnv("MAX_HISTORY_MESSAGES", 12);
export const MAX_HISTORY_ROWS = readIntEnv("MAX_HISTORY_ROWS", 5);

function readIntEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}


// Result cache: reuse the generated query plan (SQL ± full answer) for repeated
// identical questions on the same schema, avoiding the most expensive LLM call.
export const RESULT_CACHE_MAX = readIntEnv("RESULT_CACHE_MAX", 200);
export const RESULT_CACHE_TTL_MS = readIntEnv(
  "RESULT_CACHE_TTL_MS",
  15 * 60 * 1000,
); // 15 minutes
// Strict mode also reuses the cached answer/suggestions/rows (full pipeline
// short-circuit). Default off: by default we only reuse the SQL plan and
// re-execute it so returned data stays fresh.
export const RESULT_CACHE_STRICT =
  (process.env.RESULT_CACHE_STRICT ?? "false").toLowerCase() === "true";