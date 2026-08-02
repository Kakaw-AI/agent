import { beforeEach, describe, expect, it, vi } from "vitest";
import { CacheLayer } from "../../src/pipeline/layers/CacheLayer.js";
import { clearPlanCache, computeCacheKey, setCachedPlan } from "../../src/llm/cache.js";
import { SqlGenerationLayer } from "../../src/pipeline/layers/SqlGenerationLayer.js";
import type { AgentRunRequest, DatabaseKnowledgeRuntime } from "../../src/types.js";
import type { GraphStateValue } from "../../src/llm/state.js";
import type { LayerContext } from "../../src/pipeline/AgentLayer.js";

const KNOWLEDGE: DatabaseKnowledgeRuntime = {
  schemaFingerprint: "fp-memory",
  summary: "",
  tables: [
    {
      schemaName: "public",
      name: "orders",
      rowCount: 10,
      columns: [
        {
          name: "customer_id",
          normalizedName: "customer_id",
          dataType: "integer",
          isNullable: false,
          isPrimaryKey: false,
          ordinalPosition: 1,
        },
      ],
      indexes: [],
      foreignKeys: [],
    },
  ],
  knowledgeDocuments: [],
};

function buildRequest(
  overrides: Partial<AgentRunRequest> = {},
): AgentRunRequest {
  return {
    requestId: "req-1",
    conversationId: "conv-1",
    messageId: "msg-1",
    userId: "user-1",
    message: "how many orders per customer",
    history: [],
    database: {
      sourceId: "src-1",
      provider: "postgresql",
      schemaFingerprint: "fp-memory",
    },
    knowledge: KNOWLEDGE,
    llm: { connectionId: "l", provider: "anthropic", model: "m", apiKey: "k" },
    ...overrides,
  } as unknown as AgentRunRequest;
}

const state = { intentKind: "data_answer" } as unknown as GraphStateValue;
const ctx = { emit: vi.fn() } as unknown as LayerContext;

describe("CacheLayer query-memory fallback", () => {
  beforeEach(() => {
    clearPlanCache();
    vi.mocked(ctx.emit).mockClear();
  });

  it("reuses a durable plan when the in-process cache is cold", async () => {
    // This is the restart / other-replica case: the 15-minute in-process cache
    // has nothing, but the backend resolved an exact question match.
    const request = buildRequest({
      retrieval: { exactPlan: { memoryId: "mem-1", sql: "SELECT 1 FROM orders" } },
    } as Partial<AgentRunRequest>);

    const result = await new CacheLayer().execute(request, state, ctx);

    expect(result.sql).toBe("SELECT 1 FROM orders");
    expect(result.sqlFromCache).toBe(true);
    // Not a full short-circuit: the query is re-executed so data stays fresh.
    expect(result.cacheHit).toBeUndefined();
    expect(result.answer).toBeUndefined();
    expect(result.toolCalls).toEqual([
      { tool: "query_memory", hit: "exact", memoryId: "mem-1" },
    ]);
  });

  it("makes SqlGenerationLayer skip, which is the whole point", () => {
    // sqlFromCache is what removes the generation LLM call.
    const skipped = new SqlGenerationLayer().shouldSkip({
      ...state,
      sqlFromCache: true,
    } as unknown as GraphStateValue);

    expect(skipped).toBe(true);
  });

  it("prefers the in-process cache when it is warm", async () => {
    const request = buildRequest({
      retrieval: { exactPlan: { memoryId: "mem-1", sql: "SELECT 'from-memory'" } },
    } as Partial<AgentRunRequest>);

    setCachedPlan(computeCacheKey(request), {
      sql: "SELECT 'from-cache'",
      chartSpec: null,
      answer: "cached",
      suggestions: [],
      rows: [],
      columns: [],
      rowCount: 0,
    });

    const result = await new CacheLayer().execute(request, state, ctx);
    expect(result.sql).toBe("SELECT 'from-cache'");
  });

  it("is a no-op when the backend retrieved nothing", async () => {
    const result = await new CacheLayer().execute(buildRequest(), state, ctx);

    expect(result.sql).toBeUndefined();
    expect(result.sqlFromCache).toBeUndefined();
    expect(result.cacheKey).toBeTruthy();
  });
});
