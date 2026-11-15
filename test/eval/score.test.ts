import { describe, expect, it } from "vitest";
import { resultsMatch } from "../../eval/score.js";

const gold = {
  columns: ["region", "total"],
  rows: [
    { region: "Europe", total: 10.005 },
    { region: "Asia Pacific", total: 3 },
  ],
};

describe("resultsMatch", () => {
  it("ignores column names, order, row order and extra columns", () => {
    expect(
      resultsMatch(gold, {
        columns: ["id", "total_amount", "name"],
        rows: [
          { id: 2, total_amount: "3.00", name: "asia pacific" },
          { id: 1, total_amount: 10.0049, name: "Europe" },
        ],
      }),
    ).toBe(true);
  });

  it("rejects values that only match column by column, not row by row", () => {
    expect(
      resultsMatch(gold, {
        columns: ["region", "total"],
        rows: [
          { region: "Europe", total: 3 },
          { region: "Asia Pacific", total: 10.005 },
        ],
      }),
    ).toBe(false);
  });

  it("rejects a different number of rows or missing values", () => {
    expect(resultsMatch(gold, { columns: gold.columns, rows: gold.rows.slice(0, 1) })).toBe(false);
    expect(resultsMatch(gold, { columns: ["region"], rows: gold.rows.map(({ region }) => ({ region })) })).toBe(false);
  });
});
