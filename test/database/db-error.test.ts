import { describe, expect, it } from "vitest";
import {
  bareIdentifier,
  describeDbErrorForPrompt,
  normalizeDbError,
} from "../../src/database/db-error.js";
import { buildSchemaIndex } from "../../src/database/schema-index.js";
import type { DatabaseKnowledgeRuntime } from "../../src/types.js";

/** Shape of a `pg` DatabaseError, which we duck-type rather than instanceof. */
function postgresError(
  message: string,
  fields: { code?: string; hint?: string; detail?: string; position?: string } = {},
): Error {
  return Object.assign(new Error(message), fields);
}

/** Shape of a better-sqlite3 SqliteError: a code but no hint or position. */
function sqliteError(message: string, code = "SQLITE_ERROR"): Error {
  return Object.assign(new Error(message), { code });
}

const KNOWLEDGE: DatabaseKnowledgeRuntime = {
  schemaFingerprint: "fp-db-error",
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

const INDEX = buildSchemaIndex(KNOWLEDGE);

describe("normalizeDbError", () => {
  it("keeps the Postgres code, hint, detail and position", () => {
    const error = normalizeDbError(
      postgresError('column "custmer_id" does not exist', {
        code: "42703",
        hint: 'Perhaps you meant to reference the column "orders.customer_id".',
        position: "8",
      }),
    );

    expect(error.kind).toBe("undefined_column");
    expect(error.code).toBe("42703");
    expect(error.missingIdentifier).toBe("custmer_id");
    expect(error.position).toBe(8);
    // The planner's own suggestion is the single best signal available and
    // must survive verbatim.
    expect(error.hint).toBe(
      'Perhaps you meant to reference the column "orders.customer_id".',
    );
  });

  it("classifies the other Postgres codes we act on", () => {
    expect(
      normalizeDbError(
        postgresError('relation "ordrs" does not exist', { code: "42P01" }),
      ).kind,
    ).toBe("undefined_table");
    expect(
      normalizeDbError(postgresError("syntax error at or near \"FROM\"", { code: "42601" }))
        .kind,
    ).toBe("syntax");
    expect(
      normalizeDbError(
        postgresError('column reference "id" is ambiguous', { code: "42702" }),
      ).kind,
    ).toBe("ambiguous_column");
  });

  it("parses better-sqlite3 messages, which carry no hint or position", () => {
    const column = normalizeDbError(sqliteError("no such column: custmer_id"));
    expect(column.kind).toBe("undefined_column");
    expect(column.missingIdentifier).toBe("custmer_id");
    expect(column.hint).toBeNull();
    expect(column.position).toBeNull();

    const table = normalizeDbError(sqliteError("no such table: ordrs"));
    expect(table.kind).toBe("undefined_table");
    expect(table.missingIdentifier).toBe("ordrs");
  });

  it("degrades safely on values that are not errors", () => {
    const error = normalizeDbError("boom");
    expect(error.message).toBe("boom");
    expect(error.kind).toBe("other");
    expect(error.missingIdentifier).toBeNull();

    expect(normalizeDbError(undefined).message).toBe("SQL execution failed.");
  });

  it("strips a table qualifier from an identifier", () => {
    expect(bareIdentifier("orders.custmer_id")).toBe("custmer_id");
    expect(bareIdentifier("custmer_id")).toBe("custmer_id");
  });
});

describe("describeDbErrorForPrompt", () => {
  it("renders the hint and the nearest catalog columns", () => {
    const error = normalizeDbError(
      postgresError('column "custmer_id" does not exist', {
        code: "42703",
        hint: 'Perhaps you meant to reference the column "orders.customer_id".',
        position: "8",
      }),
    );

    const rendered = describeDbErrorForPrompt(
      error,
      INDEX,
      "SELECT custmer_id FROM orders",
    );

    expect(rendered).toContain("42703");
    expect(rendered).toContain("Perhaps you meant to reference");
    expect(rendered).toContain("public.orders.customer_id");
    expect(rendered).toContain("character 8");
  });

  it("omits the candidate line when nothing is close", () => {
    const error = normalizeDbError(
      postgresError('column "shipping_carrier" does not exist', { code: "42703" }),
    );
    const rendered = describeDbErrorForPrompt(error, INDEX, "SELECT 1");
    expect(rendered).not.toContain("Closest catalog");
  });
});
