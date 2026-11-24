import { MongoClient, ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncDatabase } from "../../src/database/knowledge.js";
import { executeReadOnlyQuery } from "../../src/database/query.js";
import type { AgentDatabaseRuntime } from "../../src/types.js";

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
    expect(customers.indexes[0]).toMatchObject({ name: "_id_", isPrimary: true });
    const orders = sync.catalog.tables.find((table) => table.name === "orders")!;
    expect(orders.columns.find((column) => column.name === "status")?.sampleValues).toEqual(["Cancelled", "Shipped"]);
    expect(sync.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches LIKE without case, with or without a LOWER the model added", async () => {
    const result = await executeReadOnlyQuery(database, "SELECT name FROM customers WHERE LOWER(name) LIKE '%an%'");
    expect(result.rows).toEqual([{ name: "Ann" }]);
    // The value check's direct lookup on MongoDB: an anchored, case-blind LIKE.
    const exact = await executeReadOnlyQuery(database, `SELECT DISTINCT "status" AS value FROM "orders" WHERE "status" LIKE 'shipped' LIMIT 5`);
    expect(exact.rows).toEqual([{ value: "Shipped" }]);
  });

  it("answers a grouped question", async () => {
    const result = await executeReadOnlyQuery(
      database,
      "SELECT status, COUNT(*) AS order_count, SUM(total) AS revenue FROM orders GROUP BY status ORDER BY order_count DESC",
    );
    expect(result.rows).toEqual([
      { status: "Shipped", order_count: 2, revenue: 195.5 },
      { status: "Cancelled", order_count: 1, revenue: 30 },
    ]);
  });

  it("filters on a nested field and redacts secrets", async () => {
    const result = await executeReadOnlyQuery(database, "SELECT name, password FROM customers WHERE `address.country` = 'FR'");
    expect(result.rows).toEqual([{ name: "Bob", password: "[redacted]" }]);
  });

  it("joins two collections", async () => {
    const result = await executeReadOnlyQuery(
      database,
      "SELECT c.name AS customer, SUM(o.total) AS revenue FROM customers c INNER JOIN orders AS `o|unwind` ON o.customer_id = c._id GROUP BY c.name ORDER BY revenue DESC",
    );
    expect(result.rows).toEqual([
      { customer: "Ann", revenue: 150.5 },
      { customer: "Bob", revenue: 75 },
    ]);
  });

  it("runs the distinct-values probe the value check uses", async () => {
    const result = await executeReadOnlyQuery(
      database,
      `SELECT DISTINCT "status" AS value FROM "orders" WHERE "status" IS NOT NULL LIMIT 100`,
    );
    expect(result.rows.map((row) => row.value).sort()).toEqual(["Cancelled", "Shipped"]);
  });

  it("reports a missing collection as an unknown table", async () => {
    await expect(executeReadOnlyQuery(database, "SELECT * FROM ordrs")).rejects.toThrow('relation "ordrs" does not exist');
  });

  it("rejects writes before they reach the server", async () => {
    await expect(executeReadOnlyQuery(database, "DELETE FROM orders")).rejects.toThrow(/read-only/);
  });
});
