import { describe, expect, it } from "vitest";
import { planChartSpecDeterministically, requestedChartKind } from "../../src/graph/chart-spec.js";

// The production rows behind "Show that as a bar chart" (2026-11-23).
const monthlyRevenue = {
  columns: ["order_month", "total_revenue"],
  rows: [
    { order_month: "2026-07", total_revenue: 19169 },
    { order_month: "2026-08", total_revenue: 25792 },
    { order_month: "2026-09", total_revenue: 34634 },
  ],
};

describe("requestedChartKind", () => {
  it.each([
    ["Show that as a bar chart", "bar"],
    ["make it a column chart", "bar"],
    ["plot revenue as a line graph", "line"],
    ["show it as a pie", "pie"],
    ["donut chart of orders by status", "pie"],
    ["scatter plot of price vs rating", "scatter"],
    ["histogram of order totals", "histogram"],
  ])("reads %j as %s", (text, kind) => {
    expect(requestedChartKind(text)).toBe(kind);
  });

  it.each(["chart revenue by month", "how many order lines per month?", "bar stools sold by store"])(
    "names no type in %j",
    (text) => {
      expect(requestedChartKind(text)).toBeNull();
    },
  );
});

describe("planChartSpecDeterministically", () => {
  it("draws the bar chart the user asked for over a month axis", () => {
    const spec = planChartSpecDeterministically({
      question: "Show monthly revenue for Home Decor last quarter as a bar chart",
      ...monthlyRevenue,
    });
    expect(spec?.kind).toBe("bar");
  });

  it("takes the requested kind from the newest message when the rewrite dropped it", () => {
    const spec = planChartSpecDeterministically({
      question: "How much revenue did Home Decor make each month last quarter?",
      ...monthlyRevenue,
      requestedKind: requestedChartKind("Show that as a bar chart"),
    });
    expect(spec?.kind).toBe("bar");
  });

  it("still defaults a time axis to a line when no type is named", () => {
    const spec = planChartSpecDeterministically({ question: "chart revenue by month", ...monthlyRevenue });
    expect(spec?.kind).toBe("line");
  });

  it("honours pie when it fits and falls back when there are too many slices", () => {
    expect(planChartSpecDeterministically({ question: "as a pie chart", ...monthlyRevenue })?.kind).toBe("pie");
    const many = Array.from({ length: 12 }, (_, i) => ({ order_month: `2026-${String(i + 1).padStart(2, "0")}`, total_revenue: i + 1 }));
    expect(
      planChartSpecDeterministically({ question: "as a pie chart", columns: monthlyRevenue.columns, rows: many })?.kind,
    ).toBe("line");
  });
});
