import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import { renderCatalogLine } from "../../src/database/catalog-render.js";
import { completeValueList, shouldListValues } from "../../src/database/sanitize.js";
import { listSqliteValues } from "../../src/database/sqlite.js";
import type { DatabaseCatalogTable } from "../../src/types.js";

// Mirrors the demo source behind the 2026-11-23 report: 46 categories, several
// called 'Home', and 'Home Decor' as the very last row.
const db = new Database(":memory:");
db.exec("CREATE TABLE categories (id INTEGER PRIMARY KEY, name TEXT, description TEXT, api_key TEXT)");
const insert = db.prepare("INSERT INTO categories (name, description, api_key) VALUES (?, ?, ?)");
for (let i = 1; i <= 45; i += 1) insert.run(i % 5 === 0 ? "Home" : `Category ${i}`, "x".repeat(80) + i, `k${i}`);
insert.run("Home Decor", "x".repeat(80), "k46");
afterAll(() => db.close());

function pragmaColumn(name: string) {
  const columns = db.prepare("PRAGMA table_info(categories)").all() as Array<Record<string, unknown>>;
  return columns.find((column) => column.name === name)!;
}

describe("complete value lists for short text columns", () => {
  it("puts every category name, including the last row, into the rendered catalog", () => {
    const values = listSqliteValues(db, "categories", pragmaColumn("name"), 46);
    expect(values).toContain("Home Decor");

    const table: DatabaseCatalogTable = {
      name: "categories",
      rowCount: 46,
      indexes: [],
      foreignKeys: [],
      columns: [
        { name: "name", dataType: "TEXT", isNullable: true, isPrimaryKey: false, ordinalPosition: 2, sampleValues: values! },
      ],
    };
    const line = renderCatalogLine(table);
    expect(line).toContain("values: ");
    expect(line).toContain("'Home Decor'");
    expect(line).toContain("'Home'");
  });

  it("skips long free text, secret-named columns, primary keys and big tables", () => {
    expect(listSqliteValues(db, "categories", pragmaColumn("description"), 46)).toBeNull();
    expect(listSqliteValues(db, "categories", pragmaColumn("api_key"), 46)).toBeNull();
    expect(listSqliteValues(db, "categories", pragmaColumn("id"), 46)).toBeNull();
    expect(shouldListValues({ name: "status", dataType: "character varying", isPrimaryKey: false }, 5_000_000)).toBe(false);
    expect(shouldListValues({ name: "status", dataType: "USER-DEFINED", isPrimaryKey: false }, 100)).toBe(true);
  });

  it("refuses a list that hit the cap", () => {
    expect(completeValueList(Array.from({ length: 51 }, (_, i) => `v${i}`))).toBeNull();
    expect(completeValueList(["b", "a"])).toEqual(["a", "b"]);
  });

  it("keeps old three-value samples rendered as examples", () => {
    const line = renderCatalogLine({
      name: "orders",
      rowCount: 10,
      indexes: [],
      foreignKeys: [],
      columns: [
        { name: "status", dataType: "TEXT", isNullable: true, isPrimaryKey: false, ordinalPosition: 1, sampleValues: ["Shipped", "Delivered"] },
      ],
    });
    expect(line).toContain("e.g. 'Shipped', 'Delivered'");
  });
});
