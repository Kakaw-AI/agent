import { describe, expect, it } from "vitest";
import { extractLiteralFilters, mongoTargets, resolveFilterTable } from "../../src/agent/values.js";
import { isSmallTalk } from "../../src/llm/intent/patterns.js";
import type { DatabaseKnowledgeRuntime } from "../../src/types.js";

const column = (name: string) => ({ name, dataType: "text", isNullable: false, isPrimaryKey: false, ordinalPosition: 1 });
const knowledge = {
  schemaFingerprint: null,
  summary: "",
  tables: [
    { name: "orders", columns: [column("status"), column("customer_id")], indexes: [], foreignKeys: [] },
    { name: "customers", columns: [column("region"), column("status")], indexes: [], foreignKeys: [] },
  ],
} as DatabaseKnowledgeRuntime;

describe("extractLiteralFilters", () => {
  it("finds equality, IN and LIKE filters, and skips negated ones", () => {
    const sql =
      "SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id WHERE LOWER(o.status) = 'cancelled' AND c.region IN ('APAC', 'O''Brien') AND c.status LIKE '%gold%' AND o.status NOT LIKE 'x' AND o.status <> 'y'";
    expect(extractLiteralFilters(sql)).toEqual([
      { qualifier: "o", column: "status", operator: "=", literals: ["cancelled"] },
      { qualifier: "c", column: "status", operator: "like", literals: ["%gold%"] },
      { qualifier: "c", column: "region", operator: "=", literals: ["APAC", "O'Brien"] },
    ]);
  });
});

describe("resolveFilterTable", () => {
  const sql = "SELECT * FROM orders o JOIN customers AS c ON c.id = o.customer_id WHERE c.region = 'x' AND status = 'y'";

  it("follows table aliases", () => {
    const [region] = extractLiteralFilters(sql);
    expect(resolveFilterTable(sql, region, knowledge)?.table.name).toBe("customers");
  });

  it("gives up on an unqualified column that exists in two joined tables", () => {
    const status = extractLiteralFilters(sql)[1];
    expect(resolveFilterTable(sql, status, knowledge)).toBeNull();
  });
});

describe("mongoTargets", () => {
  it("finds string filters in the leading $match stages of a pipeline", () => {
    const query = JSON.stringify({
      collection: "orders",
      pipeline: [
        { $match: { status: "cancelled", $and: [{ customer_id: { $in: ["a", "b"] } }] } },
        { $match: { status: { $regex: "ship", $options: "i" }, unknown: "x" } },
        { $lookup: { from: "customers", localField: "customer_id", foreignField: "_id", as: "c" } },
        { $match: { status: "after-lookup" } },
      ],
    });
    expect(mongoTargets(query, knowledge).map(({ column, operator, literals }) => ({ column, operator, literals }))).toEqual([
      { column: "status", operator: "=", literals: ["cancelled"] },
      { column: "customer_id", operator: "=", literals: ["a", "b"] },
      { column: "status", operator: "regex", literals: ["ship"] },
    ]);
  });

  it("finds nothing in a query that is not JSON", () => {
    expect(mongoTargets("SELECT 1", knowledge)).toEqual([]);
  });
});

describe("isSmallTalk", () => {
  it.each(["hello!", "Hi there", "thanks so much", "who are you?"])("treats %s as small talk", (text) => {
    expect(isSmallTalk(text)).toBe(true);
  });

  it.each(["hi, how many customers signed up in 2024?", "help me find the top customers", "thanks, now show revenue by month"])(
    "treats %s as a question",
    (text) => {
      expect(isSmallTalk(text)).toBe(false);
    },
  );
});
