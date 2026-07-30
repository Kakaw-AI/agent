import { beforeEach, describe, expect, it, vi } from "vitest";

const executeReadOnlyQuery = vi.fn();
const invokeJson = vi.fn();

vi.mock("../../src/database/query.js", () => ({
  executeReadOnlyQuery: (...args: unknown[]) => executeReadOnlyQuery(...args),
}));

vi.mock("../../src/llm/invoke.js", () => ({
  invokeJson: (...args: unknown[]) => invokeJson(...args),
  invokeText: vi.fn(),
}));

const { SqlExecutionLayer } = await import(
  "../../src/pipeline/layers/SqlExecutionLayer.js"
);

import type { AgentRunRequest, DatabaseKnowledgeRuntime } from "../../src/types.js";
import type { GraphStateValue } from "../../src/llm/state.js";
import type { LayerContext } from "../../src/pipeline/AgentLayer.js";

const KNOWLEDGE: DatabaseKnowledgeRuntime = {
  schemaFingerprint: "fp-repair",
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
        {
          name: "total_amount",
          normalizedName: "total_amount",
          dataType: "numeric",
          isNullable: true,
          isPrimaryKey: false,
          ordinalPosition: 2,
        },
      ],
      indexes: [],
      foreignKeys: [],
    },
  ],
  knowledgeDocuments: [],
};

function buildRequest(sql: string): AgentRunRequest {
  return {
    requestId: "req-1",
    conversationId: "conv-1",
    messageId: "msg-1",
    userId: "user-1",
    message: "total revenue per customer",
    history: [],
    database: {
      sourceId: "src-1",
      provider: "postgresql",
      connectionString: "postgres://localhost/test",
      schemaFingerprint: "fp-repair",
    },
    knowledge: KNOWLEDGE,
    llm: { connectionId: "llm-1", provider: "anthropic", model: "m", apiKey: "k" },
  } as unknown as AgentRunRequest;
}

function buildState(sql: string): GraphStateValue {
  return {
    sql,
    rows: [],
    columns: [],
    rowCount: 0,
    wantsVisualization: false,
    visualizationRequest: null,
    needsImplicitCountMetric: false,
    repairHistory: [],
    schemaCorrections: [],
  } as unknown as GraphStateValue;
}

const ctx: LayerContext = {
  emit: vi.fn(),
  onLlmCall: vi.fn(),
  onLlmResponse: vi.fn(),
} as unknown as LayerContext;

function undefinedColumnError(name: string) {
  return Object.assign(new Error(`column "${name}" does not exist`), {
    code: "42703",
    hint: `Perhaps you meant to reference the column "orders.customer_id".`,
    position: "8",
  });
}

describe("SqlExecutionLayer identifier repair", () => {
  beforeEach(() => {
    executeReadOnlyQuery.mockReset();
    invokeJson.mockReset();
    vi.mocked(ctx.emit).mockClear();
  });

  it("corrects a misspelled column in-process without any LLM call", async () => {
    executeReadOnlyQuery
      .mockRejectedValueOnce(undefinedColumnError("custmer_id"))
      .mockResolvedValueOnce({
        rowCount: 1,
        columns: ["customer_id"],
        rows: [{ customer_id: 7 }],
      });

    const layer = new SqlExecutionLayer();
    const result = await layer.execute(
      buildRequest("SELECT custmer_id FROM orders"),
      buildState("SELECT custmer_id FROM orders"),
      ctx,
    );

    // The whole point: a typo costs a string edit, not a repair round-trip.
    expect(invokeJson).not.toHaveBeenCalled();
    expect(executeReadOnlyQuery).toHaveBeenCalledTimes(2);
    expect(executeReadOnlyQuery.mock.calls[1][1]).toBe(
      "SELECT customer_id FROM orders",
    );
    expect(result.sql).toBe("SELECT customer_id FROM orders");
    expect(result.rowCount).toBe(1);
    expect(result.schemaCorrections).toEqual([
      { from: "custmer_id", to: "customer_id", stage: "sql_execution" },
    ]);
  });

  it("preserves the driver code, hint and candidates in the repair history", async () => {
    executeReadOnlyQuery
      .mockRejectedValueOnce(undefinedColumnError("custmer_id"))
      .mockResolvedValueOnce({ rowCount: 0, columns: [], rows: [] });

    const layer = new SqlExecutionLayer();
    const result = await layer.execute(
      buildRequest("SELECT custmer_id FROM orders"),
      buildState("SELECT custmer_id FROM orders"),
      ctx,
    );

    const failure = (result.repairHistory ?? []).find(
      (entry) => entry.stage === "sql_execution",
    );
    expect(failure?.code).toBe("42703");
    expect(failure?.hint).toContain("Perhaps you meant");
    expect(failure?.missingIdentifier).toBe("custmer_id");
    expect(failure?.suggestions).toEqual([
      { qualifiedName: "public.orders.customer_id", score: expect.any(Number) },
    ]);
  });

  it("never rewrites an identifier that appears only inside a string literal", async () => {
    // 'custmer_id' here is data, not an identifier; rewriting it would silently
    // change what the query asks for.
    const sql = "SELECT total_amount FROM orders WHERE label = 'custmer_id'";
    executeReadOnlyQuery.mockRejectedValueOnce(undefinedColumnError("custmer_id"));
    invokeJson.mockResolvedValue({
      value: { sql: "SELECT total_amount FROM orders" },
      tokenUsage: null,
    });
    executeReadOnlyQuery.mockResolvedValueOnce({
      rowCount: 0,
      columns: [],
      rows: [],
    });

    const layer = new SqlExecutionLayer();
    await layer.execute(buildRequest(sql), buildState(sql), ctx);

    // No safe rewrite exists, so it falls through to the LLM repair path.
    expect(invokeJson).toHaveBeenCalledTimes(1);
  });

  it("falls back to an LLM repair when the catalog has no close match", async () => {
    const sql = "SELECT shipping_carrier FROM orders";
    executeReadOnlyQuery.mockRejectedValueOnce(
      undefinedColumnError("shipping_carrier"),
    );
    invokeJson.mockResolvedValue({
      value: { sql: "SELECT total_amount FROM orders" },
      tokenUsage: null,
    });
    executeReadOnlyQuery.mockResolvedValueOnce({
      rowCount: 1,
      columns: ["total_amount"],
      rows: [{ total_amount: 5 }],
    });

    const layer = new SqlExecutionLayer();
    const result = await layer.execute(buildRequest(sql), buildState(sql), ctx);

    expect(invokeJson).toHaveBeenCalledTimes(1);
    const call = invokeJson.mock.calls[0][0];
    // The degraded "Original question: ..." prompt used to drop all of this.
    expect(call.userPrompt).toContain("Previous SQL draft");
    expect(call.userPrompt).toContain("42703");
    expect(call.userPrompt).toContain("Perhaps you meant");
    // The schema catalog stays in the cacheable system prefix.
    expect(call.systemPrompt).not.toContain("42703");
    expect(call.systemPrompt).toContain("Catalog:");
    expect(result.rowCount).toBe(1);
  });

  it("bounds free repairs so a rewrite loop cannot spin", async () => {
    // Always fails with the same unknown column, even after correction.
    executeReadOnlyQuery.mockRejectedValue(undefinedColumnError("custmer_id"));
    invokeJson.mockResolvedValue({
      value: { sql: "SELECT custmer_id FROM orders" },
      tokenUsage: null,
    });

    const layer = new SqlExecutionLayer();
    const result = await layer.execute(
      buildRequest("SELECT custmer_id FROM orders"),
      buildState("SELECT custmer_id FROM orders"),
      ctx,
    );

    expect(result.answer).toContain("attempts");
    expect(invokeJson.mock.calls.length).toBeLessThanOrEqual(2);
    expect(executeReadOnlyQuery.mock.calls.length).toBeLessThanOrEqual(6);
  });
});
