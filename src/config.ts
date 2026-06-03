export const MAX_SAMPLE_ROWS = 3;
export const MAX_RESULT_ROWS = 200;
export const LLM_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

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