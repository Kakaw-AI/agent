import { AIMessage, AIMessageChunk } from "@langchain/core/messages";
import { MongoClient, ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The model, scripted: SQL drafts come from `drafts` in order.
const fake = vi.hoisted(() => ({ drafts: [] as string[] }));
vi.mock("../../src/llm/langchain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/llm/langchain.js")>();
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2 };
  const draft = (sql: string) => ({ needsClarification: false, clarifyingQuestion: "", options: [], sql, rationale: "", needsWeb: false, webQuery: "" });
  return {
    ...actual,
    createLangChainModel: () => ({
      withStructuredOutput: (schema: { shape?: Record<string, unknown> }) => ({
        invoke: async () => {
          const shape = schema.shape ?? {};
          const parsed =
            "sql" in shape ? draft(fake.drafts.shift() ?? "")
            : "answersQuestion" in shape ? { answersQuestion: true, problem: "", needsWeb: false, webQuery: "" }
            : "suggestions" in shape ? { suggestions: [] }
            : "xField" in shape ? { kind: "bar", title: "", xField: "x", yField: "y" }
            : { kind: "data", standaloneQuestion: "" };
          return { raw: new AIMessage({ content: "", usage_metadata: usage }), parsed };
        },
      }),
      stream: async () => (async function* () { yield new AIMessageChunk({ content: "Answer.", usage_metadata: usage }); })(),
    }),
  };
});

const { syncDatabase } = await import("../../src/database/knowledge.js");
const { executeReadOnlyQuery } = await import("../../src/database/query.js");
const { streamAgent } = await import("../../src/agent/graph.js");
type AgentDatabaseRuntime = import("../../src/types.js").AgentDatabaseRuntime;

// Runs against a real server: MONGO_TEST_URL=mongodb://localhost:27017 yarn test
const baseUrl = process.env.MONGO_TEST_URL;

describe.skipIf(!baseUrl)("MongoDB end to end", () => {
  const dbName = `kakaw_test_${Date.now()}`;
  const database: AgentDatabaseRuntime = {
    sourceId: "mongo-test",
    provider: "mongodb",
    label: "Shop",
    connectionString: `${baseUrl}/${dbName}`,
  };
  let client: MongoClient;

  beforeAll(async () => {
    client = await new MongoClient(baseUrl!).connect();
    const db = client.db(dbName);
    const ann = new ObjectId();
    const bob = new ObjectId();
    await db.collection("customers").insertMany([
      { _id: ann, name: "Ann", address: { city: "Berlin", country: "DE" }, tags: ["vip"] },
      { _id: bob, name: "Bob", address: { city: "Paris", country: "FR" }, password: "hunter2" },
    ]);
    await db.collection("orders").insertMany([
      { customer_id: ann, status: "Shipped", total: 120.5, created_at: new Date("2025-01-03"), items: [{ sku: "A", qty: 2 }] },
      { customer_id: ann, status: "Cancelled", total: 30, created_at: new Date("2025-02-10"), items: [{ sku: "B", qty: 1 }] },
      { customer_id: bob, status: "Shipped", total: 75, created_at: new Date("2025-02-11"), items: [] },
    ]);
  });

  afterAll(async () => {
    await client?.db(dbName).dropDatabase();
    await client?.close();
  });

  it("syncs collections as tables with dot-path columns", async () => {
    const sync = await syncDatabase(database);
    const customers = sync.catalog.tables.find((table) => table.name === "customers")!;
    expect(customers.rowCount).toBe(2);
    expect(customers.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["_id", "name", "address.city", "address.country", "tags"]),
    );
    expect(customers.columns.find((column) => column.name === "address.country")?.sampleValues).toEqual(["DE", "FR"]);
    expect(customers.indexes?.[0]).toMatchObject({ name: "_id_", isPrimary: true });
    const orders = sync.catalog.tables.find((table) => table.name === "orders")!;
    expect(orders.columns.find((column) => column.name === "status")?.sampleValues).toEqual(["Cancelled", "Shipped"]);
    expect(sync.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  const run = (query: object) => executeReadOnlyQuery(database, JSON.stringify(query));

  it("answers a grouped question", async () => {
    const result = await run({
      collection: "orders",
      pipeline: [
        { $group: { _id: "$status", order_count: { $sum: 1 }, revenue: { $sum: "$total" } } },
        { $sort: { order_count: -1 } },
        { $project: { _id: 0, status: "$_id", order_count: 1, revenue: 1 } },
      ],
    });
    expect(result.rows).toEqual([
      { order_count: 2, revenue: 195.5, status: "Shipped" },
      { order_count: 1, revenue: 30, status: "Cancelled" },
    ]);
  });

  it("filters on a nested field, flattens sub-documents and redacts secrets", async () => {
    const result = await run({ collection: "customers", pipeline: [{ $match: { "address.country": "FR" } }, { $project: { _id: 0, name: 1, address: 1, password: 1 } }] });
    expect(result.rows).toEqual([{ name: "Bob", "address.city": "Paris", "address.country": "FR", password: "[redacted]" }]);
  });

  it("joins two collections on ObjectIds", async () => {
    const result = await run({
      collection: "customers",
      pipeline: [
        { $lookup: { from: "orders", localField: "_id", foreignField: "customer_id", as: "o" } },
        { $unwind: "$o" },
        { $group: { _id: "$name", revenue: { $sum: "$o.total" } } },
        { $sort: { revenue: -1 } },
        { $project: { _id: 0, customer: "$_id", revenue: 1 } },
      ],
    });
    expect(result.rows).toEqual([
      { revenue: 150.5, customer: "Ann" },
      { revenue: 75, customer: "Bob" },
    ]);
  });

  it("finds a filtered value the value check looks up, ignoring case", async () => {
    const result = await run({
      collection: "orders",
      pipeline: [
        { $match: { status: { $regex: "^shipped$", $options: "i" } } },
        { $group: { _id: "$status" } },
        { $project: { _id: 0, value: "$_id" } },
      ],
    });
    expect(result.rows).toEqual([{ value: "Shipped" }]);
  });

  it("reports a missing collection, joined ones included, as an unknown table", async () => {
    await expect(run({ collection: "ordrs", pipeline: [] })).rejects.toThrow('relation "ordrs" does not exist');
    await expect(
      run({ collection: "customers", pipeline: [{ $lookup: { from: "ordrs", localField: "_id", foreignField: "customer_id", as: "o" } }] }),
    ).rejects.toThrow('relation "ordrs" does not exist');
  });

  it("rejects writes before they reach the server", async () => {
    await expect(run({ collection: "orders", pipeline: [{ $merge: "copy" }] })).rejects.toThrow(/\$merge/);
  });

  it("runs a native query through the agent, fixing a wrongly cased value without another draft", async () => {
    const sync = await syncDatabase(database);
    fake.drafts = [JSON.stringify({ collection: "orders", pipeline: [{ $match: { status: "shipped" } }, { $count: "orders" }] })];
    const events: Array<{ type: string; data: Record<string, any> }> = [];
    for await (const event of streamAgent({
      requestId: "r",
      conversationId: "c",
      userId: "u",
      messageId: "m",
      message: "How many orders shipped?",
      history: [],
      database: { ...database, schemaFingerprint: sync.schemaFingerprint },
      knowledge: { schemaFingerprint: sync.schemaFingerprint, summary: "", tables: sync.catalog.tables },
      llm: { connectionId: "l", provider: "openai", model: "test", apiKey: "k" },
    } as never)) {
      events.push(event as never);
    }
    expect(events.find((event) => event.type === "message_failed")).toBeUndefined();
    expect(events.find((event) => event.type === "sql_generated")?.data.sql).toContain('"Shipped"');
    expect(events.find((event) => event.type === "sql_result")?.data.rows).toEqual([{ orders: 2 }]);
    expect(fake.drafts).toEqual([]);
  });
});
