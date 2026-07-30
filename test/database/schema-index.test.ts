import { beforeEach, describe, expect, it } from "vitest";
import {
  buildSchemaIndex,
  clearSchemaIndexCache,
  getSchemaIndex,
} from "../../src/database/schema-index.js";
import type {
  DatabaseCatalogColumn,
  DatabaseCatalogTable,
  DatabaseKnowledgeRuntime,
} from "../../src/types.js";

function column(
  name: string,
  overrides: Partial<DatabaseCatalogColumn> = {},
): DatabaseCatalogColumn {
  return {
    name,
    normalizedName: name.toLowerCase(),
    dataType: "text",
    isNullable: true,
    isPrimaryKey: false,
    ordinalPosition: 1,
    ...overrides,
  };
}

function table(
  name: string,
  columns: DatabaseCatalogColumn[],
  overrides: Partial<DatabaseCatalogTable> = {},
): DatabaseCatalogTable {
  return {
    schemaName: "public",
    name,
    rowCount: 100,
    columns,
    indexes: [],
    foreignKeys: [],
    ...overrides,
  };
}

function knowledge(
  tables: DatabaseCatalogTable[],
  schemaFingerprint: string | null = "fp-1",
): DatabaseKnowledgeRuntime {
  return {
    schemaFingerprint,
    summary: "test catalog",
    tables,
    knowledgeDocuments: [],
  };
}

const CATALOG = knowledge([
  table("customers", [
    column("customer_id", { isPrimaryKey: true, ordinalPosition: 1 }),
    column("customer_name", { ordinalPosition: 2 }),
    column("created_at", { dataType: "timestamp", ordinalPosition: 3 }),
  ]),
  table("orders", [
    column("order_id", { isPrimaryKey: true, ordinalPosition: 1 }),
    column("customer_id", { ordinalPosition: 2 }),
    column("order_date", { dataType: "date", ordinalPosition: 3 }),
    column("total_amount", { dataType: "numeric", ordinalPosition: 4 }),
  ]),
]);

describe("buildSchemaIndex", () => {
  const index = buildSchemaIndex(CATALOG);

  it("indexes every table and column with qualified names", () => {
    expect(index.tables).toHaveLength(2);
    expect(index.allColumns).toHaveLength(7);
    expect(index.getColumn("total_amount")?.qualifiedName).toBe(
      "public.orders.total_amount",
    );
    expect(index.getTable("orders")?.qualifiedName).toBe("public.orders");
    expect(index.getTable("public.orders")?.name).toBe("orders");
  });

  it("recomputes normalization rather than trusting the wire field", () => {
    const stale = knowledge([
      table("orders", [column("Order Date", { normalizedName: "wrong_value" })]),
    ]);
    const staleIndex = buildSchemaIndex(stale);
    expect(staleIndex.getColumn("order_date")?.name).toBe("Order Date");
  });
});

describe("resolveColumn", () => {
  const index = buildSchemaIndex(CATALOG);

  it("resolves an exact name without rewriting it", () => {
    const result = index.resolveColumn("total_amount");
    expect(result?.exact).toBe(true);
    expect(result?.matchKind).toBe("exact");
    expect(result?.column.name).toBe("total_amount");
  });

  it("resolves a case or separator variant as an exact match", () => {
    const result = index.resolveColumn("TotalAmount");
    expect(result?.exact).toBe(true);
    expect(result?.column.name).toBe("total_amount");
  });

  it("corrects a single-character typo", () => {
    const result = index.resolveColumn("totl_amount");
    expect(result?.column.name).toBe("total_amount");
    expect(result?.exact).toBe(false);
    expect(result?.matchKind).toBe("fuzzy");
    expect(result?.ambiguous).toBe(false);
  });

  it("flags a name shared across tables as ambiguous but still exact", () => {
    const result = index.resolveColumn("customer_id");
    expect(result?.exact).toBe(true);
    expect(result?.ambiguous).toBe(true);
    // Deterministic tie-break: the table whose name overlaps the candidate wins.
    expect(result?.table.name).toBe("customers");
    expect(result?.alternatives[0]?.column.table.name).toBe("orders");
  });

  it("is deterministic across repeated resolutions", () => {
    const first = index.resolveColumn("customer_id");
    const second = index.resolveColumn("customer_id");
    expect(first?.column.qualifiedName).toBe(second?.column.qualifiedName);
  });

  it("honours a table hint", () => {
    const result = index.resolveColumn("customer_id", { tableHint: "orders" });
    expect(result?.table.name).toBe("orders");
    expect(result?.ambiguous).toBe(false);
  });

  it("returns null when nothing is close enough", () => {
    expect(index.resolveColumn("shipping_carrier")).toBeNull();
  });

  it("returns null for blank input", () => {
    expect(index.resolveColumn("")).toBeNull();
    expect(index.resolveColumn("   ")).toBeNull();
  });
});

describe("resolveTable", () => {
  const index = buildSchemaIndex(CATALOG);

  it("resolves exact, plural and misspelled table names", () => {
    expect(index.resolveTable("orders")?.table.name).toBe("orders");
    expect(index.resolveTable("order")?.table.name).toBe("orders");
    expect(index.resolveTable("custmers")?.table.name).toBe("customers");
  });

  it("returns null for an unknown table", () => {
    expect(index.resolveTable("invoices")).toBeNull();
  });
});

describe("suggestions", () => {
  const index = buildSchemaIndex(CATALOG);

  it("ranks the closest columns first", () => {
    const suggestions = index.suggestColumns("custmer_name");
    expect(suggestions[0]?.qualifiedName).toBe("public.customers.customer_name");
    expect(suggestions[0]?.score).toBeGreaterThan(0.8);
  });

  it("offers a column the user only partly named", () => {
    const suggestions = index.suggestColumns("amount");
    expect(suggestions.map((s) => s.qualifiedName)).toContain(
      "public.orders.total_amount",
    );
  });

  it("returns nothing for an unrelated name", () => {
    expect(index.suggestColumns("shipping_carrier")).toEqual([]);
  });
});

describe("getSchemaIndex memoization", () => {
  beforeEach(() => {
    clearSchemaIndexCache();
  });

  it("reuses the index for the same fingerprint", () => {
    const first = getSchemaIndex(CATALOG);
    const second = getSchemaIndex(knowledge([...CATALOG.tables], "fp-1"));
    expect(second).toBe(first);
  });

  it("rebuilds when the fingerprint changes", () => {
    const first = getSchemaIndex(CATALOG);
    const second = getSchemaIndex(knowledge([...CATALOG.tables], "fp-2"));
    expect(second).not.toBe(first);
  });

  it("derives an identity structurally when no fingerprint is supplied", () => {
    const first = getSchemaIndex(knowledge([...CATALOG.tables], null));
    const second = getSchemaIndex(knowledge([...CATALOG.tables], null));
    expect(second).toBe(first);

    const different = getSchemaIndex(
      knowledge([table("invoices", [column("invoice_id")])], null),
    );
    expect(different).not.toBe(first);
  });

  it("evicts the least recently used entry beyond the cap", () => {
    const built = Array.from({ length: 6 }, (_, i) =>
      getSchemaIndex(knowledge([...CATALOG.tables], `fp-${i}`)),
    );
    // The cap is 4, so the first two identities were evicted and rebuild fresh.
    expect(getSchemaIndex(knowledge([...CATALOG.tables], "fp-0"))).not.toBe(
      built[0],
    );
    expect(getSchemaIndex(knowledge([...CATALOG.tables], "fp-5"))).toBe(built[5]);
  });
});
