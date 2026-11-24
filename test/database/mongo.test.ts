import { Decimal128, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  assertReadOnlyPipeline,
  inferColumns,
  parseMongoConnectionString,
  toPlain,
  translateSql,
} from "../../src/database/mongo.js";

const mongoDatabaseName = (value: string) => parseMongoConnectionString(value).database;

describe("parseMongoConnectionString", () => {
  it("reads the database and seed hosts", () => {
    expect(parseMongoConnectionString("mongodb+srv://u:p@cluster0.example.net/shop?retryWrites=true&w=majority")).toEqual({
      database: "shop",
      hosts: ["cluster0.example.net"],
    });
    expect(parseMongoConnectionString("mongodb://u:p@h1:27017,[::1]:27018,10.0.0.5/sales?replicaSet=rs0&authSource=admin")).toEqual({
      database: "sales",
      hosts: ["h1", "::1", "10.0.0.5"],
    });
  });

  it("refuses unix socket hosts, which never resolve through the network guard", () => {
    expect(() => mongoDatabaseName("mongodb://%2Ftmp%2Fmongodb-27017.sock/admin")).toThrow(/socket/);
  });

  it("requires a database name", () => {
    expect(() => mongoDatabaseName("mongodb://u:p@host:27017")).toThrow(/name a database/);
    expect(() => mongoDatabaseName("mongodb://u:p@host:27017/?tls=true")).toThrow(/name a database/);
  });

  it("refuses options that reach this machine's files, credentials or a proxy", () => {
    expect(() => mongoDatabaseName("mongodb://h/db?tlsCAFile=/etc/passwd")).toThrow(/tlsCAFile/);
    expect(() => mongoDatabaseName("mongodb://h/db?proxyHost=10.0.0.1")).toThrow(/proxyHost/);
    expect(() => mongoDatabaseName("mongodb://h/db?authMechanism=MONGODB-AWS")).toThrow(/MONGODB-AWS/);
    expect(mongoDatabaseName("mongodb://h/db?authMechanism=SCRAM-SHA-256")).toBe("db");
  });

  it("refuses other schemes", () => {
    expect(() => mongoDatabaseName("postgresql://h/db")).toThrow(/mongodb:\/\//);
  });
});

describe("assertReadOnlyPipeline", () => {
  it("blocks writing stages and server-side JavaScript, however deep", () => {
    expect(() => assertReadOnlyPipeline([{ $match: {} }, { $out: "x" }])).toThrow(/\$out/);
    expect(() => assertReadOnlyPipeline([{ $lookup: { pipeline: [{ $merge: "x" }] } }])).toThrow(/\$merge/);
    expect(() => assertReadOnlyPipeline([{ $match: { $where: "1" } }])).toThrow(/\$where/);
    expect(() => assertReadOnlyPipeline([{ $group: { _id: null, x: { $accumulator: {} } } }])).toThrow(/\$accumulator/);
    expect(() => assertReadOnlyPipeline([{ $match: { status: "x" } }, { $limit: 5 }])).not.toThrow();
  });
});

describe("translateSql", () => {
  it("translates a grouped count", () => {
    const { collections, pipeline } = translateSql(
      "SELECT status, COUNT(*) AS orders FROM orders GROUP BY status ORDER BY orders DESC LIMIT 5",
    );
    expect(collections).toEqual(["orders"]);
    expect(JSON.stringify(pipeline)).toContain("$group");
  });

  it("reads backticked dot paths as nested fields", () => {
    const { pipeline } = translateSql(
      "SELECT `address.city` AS city, COUNT(*) AS n FROM customers WHERE `address.country` = 'DE' GROUP BY `address.city`",
    );
    const text = JSON.stringify(pipeline);
    expect(text).toContain("address.country");
    expect(text).toContain("$address.city");
  });

  it("translates a join with an unwind hint", () => {
    const { collections, pipeline } = translateSql(
      "SELECT c.country, SUM(o.total) AS revenue FROM customers c INNER JOIN orders AS `o|unwind` ON o.customer_id = c._id GROUP BY c.country",
    );
    expect(collections).toContain("customers");
    expect(JSON.stringify(pipeline)).toContain("$lookup");
  });

  it("translates the distinct-values probe the value check runs", () => {
    const { collections } = translateSql(
      "SELECT DISTINCT `status` AS value FROM `orders` WHERE `status` IS NOT NULL LIMIT 100",
    );
    expect(collections).toEqual(["orders"]);
  });

  it("reads double-quoted names as fields too", () => {
    const { collections, pipeline } = translateSql(`SELECT "status" AS s FROM "orders" WHERE "status" = 'paid'`);
    expect(collections).toEqual(["orders"]);
    // The value check (values.ts) quotes this way, and so do models used to Postgres.
    expect(pipeline[0]).toEqual({ $match: { status: { $eq: "paid" } } });
  });

  it("raises a parse error the repair loop can show the model", () => {
    expect(() => translateSql("SELECT FROM WHERE")).toThrow();
  });
});

describe("inferColumns", () => {
  it("flattens sub-documents, puts _id first and marks missing fields nullable", () => {
    const id = new ObjectId();
    const columns = inferColumns([
      { name: "Ann", _id: id, address: { city: "Berlin" }, tags: ["a"] },
      { name: "Bob", _id: id, address: { city: "Paris", zip: "75001" } },
    ]);
    expect(columns.map((column) => column.name)).toEqual(["_id", "name", "address.city", "tags", "address.zip"]);
    expect(columns[0]).toMatchObject({ dataType: "objectId", isPrimaryKey: true, isNullable: false });
    expect(columns.find((column) => column.name === "tags")).toMatchObject({ dataType: "array", isNullable: true });
    expect(columns.find((column) => column.name === "address.city")).toMatchObject({ dataType: "string", isNullable: false });
  });

  it("drops the rarest fields of very wide documents, not the last seen", () => {
    const wide = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`rare_${i}`, 1]));
    const columns = inferColumns([{ ...wide, common: "x" }, { common: "y" }]);
    expect(columns).toHaveLength(100);
    expect(columns.map((column) => column.name)).toContain("common");
  });
});

describe("toPlain", () => {
  it("turns BSON values into JSON-safe ones", () => {
    const id = new ObjectId();
    expect(toPlain({ _id: id, price: Decimal128.fromString("9.50"), at: new Date(0), items: [{ id }] })).toEqual({
      _id: id.toHexString(),
      price: 9.5,
      at: new Date(0),
      items: [{ id: id.toHexString() }],
    });
  });

  it("redacts secret-looking fields inside nested documents", () => {
    expect(toPlain({ profile: { name: "Ann", password: "x", sessions: [{ token: "t" }] } })).toEqual({
      profile: { name: "Ann", password: "[redacted]", sessions: "[redacted]" },
    });
    expect(toPlain({ items: [{ apiKey: "k" }] })).toEqual({ items: [{ apiKey: "[redacted]" }] });
  });
});

describe("network guard", () => {
  it("refuses private IP literals as seed hosts in production", async () => {
    const { executeReadOnlyQuery } = await import("../../src/database/query.js");
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      for (const connectionString of ["mongodb://127.0.0.1:27017/db", "mongodb://169.254.169.254/db", "mongodb://[::1]:27017/db"]) {
        await expect(
          executeReadOnlyQuery({ sourceId: "s", provider: "mongodb", label: "x", connectionString }, "SELECT * FROM t"),
        ).rejects.toThrow(/private or internal/);
      }
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
