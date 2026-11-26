import { describe, expect, it } from "vitest";
import { planChartSpecDeterministically, requestedChartKind } from "../../src/graph/chart-spec.js";
import { buildVisualizationRequestFromQuestion } from "../../src/llm/intent/visualization-request.js";

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

describe("chart shape follows the table", () => {
  const plan = (columns: string[], rows: Array<Record<string, unknown>>, question = "visualize this") =>
    planChartSpecDeterministically({ question, columns, rows });

  it("draws two measures per category as bars plus a line on its own axis", () => {
    const spec = plan(["category", "revenue", "order_count"], [
      { category: "Home", revenue: 52000, order_count: 310 },
      { category: "Toys", revenue: 18000, order_count: 420 },
      { category: "Books", revenue: 9000, order_count: 150 },
    ]);
    expect(spec).toMatchObject({ kind: "combo", yField: "revenue", y2Field: "order_count" });
  });

  it("draws three measures per row as a labelled bubble chart", () => {
    const rows = ["Ann", "Bob", "Cy", "Dee", "Eve"].map((customer, i) => ({
      customer,
      total_revenue: 1000 * (i + 1),
      orders: 3 + i,
      avg_order_value: 200 + i * 10,
    }));
    const spec = plan(["customer", "total_revenue", "orders", "avg_order_value"], rows);
    expect(spec).toMatchObject({ kind: "bubble", labelField: "customer", sizeField: "avg_order_value" });
  });

  it("uses a heatmap when category x series is too wide for grouped bars", () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      ["A", "B", "C", "D", "E", "F", "G", "H"].map((region) => ({ product: `P${i}`, region, sales: i + region.charCodeAt(0) })),
    ).flat();
    expect(plan(["product", "region", "sales"], rows)?.kind).toBe("heatmap");
  });

  it("draws one line per series over time", () => {
    const rows = ["2026-07", "2026-08", "2026-09"].flatMap((order_month) =>
      ["Web", "Store"].map((channel, i) => ({ order_month, channel, revenue: 100 * (i + 1) })),
    );
    expect(plan(["order_month", "channel", "revenue"], rows)).toMatchObject({ kind: "line", seriesField: "channel" });
  });

  it("ranks a long list as horizontal bars and ignores ids", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ product_id: i, product_name: `Product ${i}`, units: 50 - i }));
    expect(plan(["product_id", "product_name", "units"], rows)).toMatchObject({ kind: "hbar", xField: "product_name", yField: "units" });
  });

  it("treats a per-row attribute as a label, not a series", () => {
    const rows = ["Ann", "Bob", "Cy"].map((name, i) => ({ name, city: `City ${i}`, spend: 10 * (i + 1) }));
    expect(plan(["name", "city", "spend"], rows)?.seriesField ?? null).toBeNull();
  });
});

// "top N things by <measure>": the words after "by" rank the rows, they are not
// the x axis. Production drew units on both axes and the names as colours (2026-11-26).
describe("a ranking asked as 'by <measure>'", () => {
  const rows = [
    { units_sold: 330, product_name: "Marble Bookends" },
    { units_sold: 316, product_name: "Woven Wall Hanging" },
    { units_sold: 292, product_name: "Velvet Throw Pillow" },
    { units_sold: 283, product_name: "Ceramic Table Lamp" },
    { units_sold: 283, product_name: "Macrame Plant Hanger" },
  ];
  const plan = (question: string, columns: string[], data: Array<Record<string, unknown>>) =>
    planChartSpecDeterministically({ question, columns, rows: data, visualizationRequest: buildVisualizationRequestFromQuestion(question) });

  it("puts the names on the axis and the measure on the bars", () => {
    const spec = plan("Chart the top 5 products by units sold", ["units_sold", "product_name"], rows);
    expect(spec).toMatchObject({ xField: "product_name", yField: "units_sold" });
    expect(spec?.seriesField).toBeUndefined();
  });

  it("ranks by the named measure even when another column looks more like one", () => {
    const data = rows.map((row, i) => ({ ...row, total_revenue: 1000 + i }));
    const spec = plan("Chart the top 5 products by units sold", ["product_name", "units_sold", "total_revenue"], data);
    expect(spec).toMatchObject({ xField: "product_name", yField: "units_sold" });
  });

  it("still uses a number as the axis when there is no text column", () => {
    const data = [{ rating: 4, order_count: 10 }, { rating: 5, order_count: 12 }];
    expect(plan("Chart orders by rating", ["rating", "order_count"], data)).toMatchObject({ xField: "rating", yField: "order_count" });
  });
});
