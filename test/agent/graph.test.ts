import { AIMessage, AIMessageChunk, type BaseMessage } from "@langchain/core/messages";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// A scripted stand-in for the model. Each structured call is answered by the
// next scripted reply for its schema (or a default); every prompt is recorded.
const fake = vi.hoisted(() => ({
  replies: new Map<unknown, unknown[]>(),
  defaults: new Map<unknown, (messages: unknown[]) => unknown>(),
  prompts: new Map<unknown, string[]>(),
  answer: "Here is what the data shows.",
}));

vi.mock("../../src/llm/langchain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/llm/langchain.js")>();
  const usage = { input_tokens: 10, output_tokens: 5, total_tokens: 15 };
  return {
    ...actual,
    createLangChainModel: () => ({
      withStructuredOutput: (schema: unknown) => ({
        invoke: async (messages: BaseMessage[]) => {
          const prompts = fake.prompts.get(schema) ?? [];
          prompts.push(String(messages[messages.length - 1].content));
          fake.prompts.set(schema, prompts);
          const queued = fake.replies.get(schema);
          const parsed = queued && queued.length > 0 ? queued.shift() : fake.defaults.get(schema)?.(messages);
          if (parsed instanceof Error) throw parsed;
          return { raw: new AIMessage({ content: "", usage_metadata: usage }), parsed };
        },
      }),
      stream: async () =>
        (async function* () {
          yield new AIMessageChunk({ content: fake.answer, usage_metadata: usage });
        })(),
    }),
  };
});

const { streamAgent } = await import("../../src/agent/graph.js");
const { RouteSchema, SqlDraftSchema, SuggestionsSchema, VerifySchema, ChartPlanSchema } = await import("../../src/llm/schemas.js");
const { clearPlanCache } = await import("../../src/llm/cache.js");
const { syncDatabase } = await import("../../src/database/knowledge.js");
const { cacheFilePath } = await import("../../src/database/materialize.js");
const { seedShopDatabase } = await import("../../eval/seed.js");
type AgentRunRequest = import("../../src/types.js").AgentRunRequest;
type AgentHistoryMessage = import("../../src/types.js").AgentHistoryMessage;
type Event = { type: string; data: Record<string, any> };

const draft = (sql: string, rationale = "") => ({ needsClarification: false, clarifyingQuestion: "", options: [], sql, rationale });

let base: Omit<AgentRunRequest, "message" | "history">;

beforeAll(async () => {
  const seed = join(mkdtempSync(join(tmpdir(), "kakaw-graph-test-")), "shop.sqlite");
  seedShopDatabase(seed);
  const database = { sourceId: "graph-test", provider: "sqlite" as const, label: "Shop", sqliteObjectKey: "graph-test/shop.sqlite" };
  mkdirSync(dirname(cacheFilePath(database.sqliteObjectKey)), { recursive: true });
  copyFileSync(seed, cacheFilePath(database.sqliteObjectKey));
  const sync = await syncDatabase(database);

  base = {
    requestId: "req",
    conversationId: "conv",
    userId: "user",
    messageId: "msg",
    database: { ...database, schemaFingerprint: sync.schemaFingerprint },
    knowledge: {
      schemaFingerprint: sync.schemaFingerprint,
      summary: "",
      tables: sync.catalog.tables,
      knowledgeDocuments: sync.catalog.knowledgeDocuments,
    },
    llm: { connectionId: "llm", provider: "openai", model: "test", apiKey: "k" },
  };
});

beforeEach(() => {
  clearPlanCache();
  fake.replies.clear();
  fake.prompts.clear();
  fake.defaults.set(VerifySchema, () => ({ answersQuestion: true, problem: "" }));
  fake.defaults.set(SuggestionsSchema, () => ({ suggestions: ["One?", "Two?", "Three?"] }));
  fake.defaults.set(ChartPlanSchema, () => ({ kind: "bar", title: "", xField: "missing", yField: "missing" }));
});

function script(schema: unknown, ...replies: unknown[]) {
  fake.replies.set(schema, replies);
}

const promptsFor = (schema: unknown) => fake.prompts.get(schema) ?? [];

async function run(message: string, extra: Partial<AgentRunRequest> = {}): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of streamAgent({ ...base, message, history: [], ...extra } as AgentRunRequest)) {
    events.push(event as Event);
  }
  return events;
}

const find = (events: Event[], type: string) => events.find((event) => event.type === type)?.data;
const trace = (events: Event[]) => find(events, "agent_trace")!;

function turn(question: string, sql: string, rows: Array<Record<string, unknown>>): AgentHistoryMessage[] {
  return [
    { role: "user", content: question },
    { role: "assistant", content: `Here are the results for "${question}".`, sql, rows, columns: Object.keys(rows[0] ?? {}) },
  ];
}

describe("agent graph", () => {
  it("answers a greeting without calling the model", async () => {
    const events = await run("hello!");
    expect(find(events, "message_completed")?.content).toMatch(/ask me a question/i);
    expect(find(events, "sql_generated")).toBeUndefined();
    expect(fake.prompts.size).toBe(0);
  });

  it("treats a question that starts with a greeting as a data question", async () => {
    script(SqlDraftSchema, draft("SELECT COUNT(*) AS customers FROM customers WHERE strftime('%Y', signup_date) = '2024'"));
    const events = await run("hi, how many customers signed up in 2024?");
    expect(find(events, "sql_result")?.rows).toEqual([{ customers: 38 }]);
  });

  it("fixes a filter value that differs from the stored one only by case, without another draft", async () => {
    script(SqlDraftSchema, draft("SELECT COUNT(*) AS cancelled FROM orders WHERE status = 'cancelled'"));
    const events = await run("How many orders were cancelled?");

    expect(find(events, "sql_generated")?.sql).toContain("'Cancelled'");
    expect(find(events, "sql_result")?.rows).toEqual([{ cancelled: 61 }]);
    expect(promptsFor(SqlDraftSchema)).toHaveLength(1);
    expect(trace(events).repairHistory.some((entry: any) => entry.stage === "value_check")).toBe(true);
  });

  it("shows the model the stored values when a filter matches none of them", async () => {
    script(
      SqlDraftSchema,
      draft("SELECT COUNT(*) AS customers FROM customers WHERE region = 'APAC'"),
      draft("SELECT COUNT(*) AS customers FROM customers WHERE region = 'Asia Pacific'"),
    );
    const events = await run("How many customers are based in APAC?");

    expect(promptsFor(SqlDraftSchema)[1]).toContain("'Asia Pacific'");
    expect(find(events, "sql_result")?.rows).toEqual([{ customers: 15 }]);
  });

  it("corrects a misspelled column without another draft", async () => {
    script(SqlDraftSchema, draft("SELECT COUNT(DISTINCT custmer_id) AS buyers FROM orders"));
    const events = await run("How many different customers have ordered?");

    expect(find(events, "sql_generated")?.sql).toContain("customer_id");
    expect(find(events, "sql_result")?.rowCount).toBe(1);
    expect(promptsFor(SqlDraftSchema)).toHaveLength(1);
  });

  it("repairs a database error with the error in the next draft", async () => {
    script(SqlDraftSchema, draft("SELECT COUNT(* FROM orders"), draft("SELECT COUNT(*) AS orders FROM orders"));
    const events = await run("How many orders are there?");

    expect(promptsFor(SqlDraftSchema)[1]).toMatch(/syntax error|incomplete input/i);
    expect(find(events, "sql_result")?.rows).toEqual([{ orders: 600 }]);
  });

  it("asks a clarifying question and offers the readings as suggestions", async () => {
    script(SqlDraftSchema, {
      needsClarification: true,
      clarifyingQuestion: "Best by what: total spent or number of orders?",
      options: ["Who spent the most?", "Who placed the most orders?"],
      sql: "",
      rationale: "",
    });
    const events = await run("Who are our best customers?");

    expect(find(events, "sql_generated")).toBeUndefined();
    expect(find(events, "message_completed")?.content).toBe("Best by what: total spent or number of orders?");
    expect(find(events, "suggestions_generated")?.suggestions).toEqual(["Who spent the most?", "Who placed the most orders?"]);
    expect(trace(events).analyticsOutcome).toBe("clarification");
  });

  it("does not ask again right after asking", async () => {
    script(
      SqlDraftSchema,
      { needsClarification: true, clarifyingQuestion: "Which one?", options: [], sql: "SELECT COUNT(*) AS n FROM customers", rationale: "" },
    );
    script(RouteSchema, { kind: "data", standaloneQuestion: "How many customers are there?" });
    const events = await run("total spent", {
      history: [
        { role: "user", content: "Who are our best customers?" },
        { role: "assistant", content: "Best by what: total spent or number of orders?" },
      ],
    });
    expect(find(events, "sql_result")?.rows).toEqual([{ n: 80 }]);
  });

  it("keys the plan cache on the rewritten question, so the same follow-up text in two conversations gets two answers", async () => {
    const regionTotals = turn("What was the total order amount in each region in 2024?", "SELECT 1", [{ region: "Europe", total: 1 }]);
    const signups = turn("How many customers signed up in 2024?", "SELECT 1", [{ customers: 38 }]);

    script(RouteSchema, { kind: "data", standaloneQuestion: "What was the total order amount in each region in 2025?" });
    script(SqlDraftSchema, draft("SELECT c.region, SUM(o.total_amount) AS total FROM orders o JOIN customers c ON c.id = o.customer_id WHERE strftime('%Y', o.order_date) = '2025' GROUP BY c.region"));
    const first = await run("what about 2025?", { history: regionTotals });

    script(RouteSchema, { kind: "data", standaloneQuestion: "How many customers signed up in 2025?" });
    script(SqlDraftSchema, draft("SELECT COUNT(*) AS customers FROM customers WHERE strftime('%Y', signup_date) = '2025'"));
    const second = await run("what about 2025?", { history: signups });

    expect(find(first, "sql_result")?.rowCount).toBe(4);
    expect(find(second, "sql_result")?.rows).toEqual([{ customers: 19 }]);
    expect(promptsFor(SqlDraftSchema)).toHaveLength(2);
    expect(trace(second).standaloneQuestion).toBe("How many customers signed up in 2025?");
    // The earlier SQL reaches the router, so the rewrite can build on it.
    expect(promptsFor(RouteSchema)[0]).toContain("[SQL used]");
  });

  it("ignores a query-memory match for a rewritten follow-up, and uses it for a question that stands alone", async () => {
    const memory = { exactPlan: { memoryId: "m1", sql: "SELECT COUNT(*) AS wrong FROM customers" } };

    script(RouteSchema, { kind: "data", standaloneQuestion: "What is the average order amount in Latin America?" });
    script(SqlDraftSchema, draft("SELECT AVG(o.total_amount) AS avg FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.region = 'Latin America'"));
    const followUp = await run("what about Latin America?", {
      history: turn("What is the average order amount in Europe?", "SELECT 1", [{ avg: 1157.4 }]),
      retrieval: memory,
    });
    expect(find(followUp, "sql_generated")?.sql).toContain("AVG");

    const standalone = await run("How many customers do we have?", { retrieval: memory });
    expect(find(standalone, "sql_generated")?.sql).toBe(memory.exactPlan.sql);
    expect(promptsFor(SqlDraftSchema)).toHaveLength(1);
  });

  it("rewrites once when the review flags the result, and does not review the rewrite", async () => {
    script(
      SqlDraftSchema,
      draft("SELECT COUNT(*) AS orders FROM orders"),
      draft("SELECT COUNT(*) AS orders FROM orders WHERE ship_mode = 'Express'"),
    );
    script(VerifySchema, { answersQuestion: false, problem: "The query ignores the express-shipping filter." });
    const events = await run("How many orders used express shipping?");

    expect(promptsFor(SqlDraftSchema)[1]).toContain("express-shipping filter");
    expect(promptsFor(VerifySchema)).toHaveLength(1);
    expect(find(events, "sql_result")?.rows).toEqual([{ orders: 185 }]);

    // Query memory learns only from the accepted query.
    const executions = trace(events).toolCalls.filter((call: any) => call.tool === "sql_execution");
    expect(executions).toEqual([{ tool: "sql_execution", sql: "SELECT COUNT(*) AS orders FROM orders WHERE ship_mode = 'Express'", rowCount: 1 }]);
  });

  it("sends the table before the answer streams, closes in order, and counts tokens from every call", async () => {
    script(SqlDraftSchema, draft("SELECT category, COUNT(*) AS products FROM products GROUP BY category"));
    const events = await run("How many products are there in each category?");
    const order = events.map((event) => event.type);

    expect(order.indexOf("sql_result")).toBeLessThan(order.indexOf("message_delta"));
    expect(order.slice(-3)).toEqual(["message_completed", "suggestions_generated", "agent_trace"]);
    // draft + review + suggestions + streamed answer, 10 input tokens each
    expect(find(events, "message_completed")?.tokenUsage?.inputTokens).toBe(40);
  });

  it("still charts the previous result when the routing call fails", async () => {
    script(RouteSchema, new Error("model timed out"));
    const rows = [
      { category: "Electronics", total: 244776.32 },
      { category: "Furniture", total: 427176 },
    ];
    const events = await run("plot that", { history: turn("What is the total order amount per product category?", "SELECT category, total FROM x", rows) });

    expect(promptsFor(SqlDraftSchema)).toHaveLength(0);
    expect(find(events, "sql_result")?.rows).toEqual(rows);
  });

  it("charts the previous result without querying again", async () => {
    script(RouteSchema, { kind: "chart_previous", standaloneQuestion: "Show total order amount per category as a chart" });
    const rows = [
      { category: "Electronics", total: 244776.32 },
      { category: "Furniture", total: 427176 },
      { category: "Office Supplies", total: 45516.48 },
    ];
    const events = await run("chart it", { history: turn("What is the total order amount per product category?", "SELECT category, total FROM x", rows) });

    expect(promptsFor(SqlDraftSchema)).toHaveLength(0);
    expect(find(events, "sql_result")?.rows).toEqual(rows);
    expect(find(events, "chart_generated")).toBeDefined();
  });
});
