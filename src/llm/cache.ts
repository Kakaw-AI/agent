import { createHash } from "node:crypto";
import {
  RESULT_CACHE_MAX,
  RESULT_CACHE_TTL_MS,
} from "../config.js";
import { computeSchemaIdentity } from "../database/schema-index.js";
import { normalizeQuestion } from "../utils/text.js";
import type {
  AgentRunRequest,
  VisualizationChartSpec,
} from "../types.js";

/**
 * The reusable "plan" for a question. The SQL is always reused (skips the
 * expensive SQL-generation LLM call); the remaining fields are only consumed
 * when RESULT_CACHE_STRICT is enabled, where the whole pipeline is
 * short-circuited.
 */
export type CachedPlan = {
  sql: string;
  chartSpec: VisualizationChartSpec | null;
  answer: string;
  suggestions: string[];
  rows: Array<Record<string, unknown>>;
  columns: string[];
  rowCount: number;
};

type CacheEntry = {
  value: CachedPlan;
  expiresAt: number;
};

// Simple in-process LRU. Insertion order in a Map is preserved, so the first
// key is the least-recently-used. Fine for the current single-instance
// deployment; swap for Redis behind this same interface if agent-ts is scaled.
const store = new Map<string, CacheEntry>();

function schemaIdentity(request: AgentRunRequest): string {
  // Shared with the schema index so the two caches cannot disagree about which
  // catalog they are holding.
  return computeSchemaIdentity(
    request.knowledge,
    request.database.schemaFingerprint,
  );
}

/**
 * Keyed on the standalone question, not the user's text. "what about 2025?"
 * means something different in every conversation, and keying on the raw text
 * served one conversation's SQL to another.
 */
export function computeCacheKey(request: AgentRunRequest, question: string): string {
  return createHash("sha256")
    .update(schemaIdentity(request))
    .update("\0")
    .update(normalizeQuestion(question))
    .update("\0")
    .update(request.llm.provider)
    .update("\0")
    .update(request.llm.model)
    .digest("hex");
}

export function getCachedPlan(key: string): CachedPlan | null {
  const entry = store.get(key);
  if (!entry) {
    return null;
  }

  if (entry.expiresAt <= Date.now()) {
    store.delete(key);
    return null;
  }

  // Refresh recency: delete + re-insert moves the key to the most-recent slot.
  store.delete(key);
  store.set(key, entry);
  return entry.value;
}

export function setCachedPlan(key: string, value: CachedPlan): void {
  if (RESULT_CACHE_MAX <= 0) {
    return;
  }

  store.delete(key);
  store.set(key, { value, expiresAt: Date.now() + RESULT_CACHE_TTL_MS });

  while (store.size > RESULT_CACHE_MAX) {
    const oldestKey = store.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    store.delete(oldestKey);
  }
}

/** Exposed for tests. */
export function clearPlanCache(): void {
  store.clear();
}
