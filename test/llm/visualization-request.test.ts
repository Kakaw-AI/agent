import { describe, expect, it } from "vitest";
import { requestedChartKind } from "../../src/graph/chart-spec.js";
import { buildVisualizationRequestFromQuestion } from "../../src/llm/intent/visualization-request.js";

// Production, 2026-11-24: asked in one message, the month column came back
// aliased as "each month last quarter as a bar chart", because that whole
// phrase was parsed as a field the SQL step had to keep.
describe("buildVisualizationRequestFromQuestion keeps the chart type out of the fields", () => {
  it.each([
    ["Show Home Decor revenue for each month last quarter as a bar chart", ["month"], "bar"],
    ["Show Home Decor revenue for each month last quarter as a line chart", ["month"], "line"],
    ["Show Home Decor revenue by category in a pie chart", ["category"], "pie"],
    ["Show me a chart of Home Decor revenue by month", ["month"], null],
    ["Bar chart of Home Decor revenue per month this year", ["month"], "bar"],
    ["Plot order count by status as a pie", ["status"], "pie"],
  ])("%j", (question, categoryFields, kind) => {
    const request = buildVisualizationRequestFromQuestion(question);
    expect(request?.categoryFields).toEqual(categoryFields);
    expect(JSON.stringify(request)).not.toMatch(/chart|graph|plot|\bpie\b|\bbar\b|\bline\b|quarter/i);
    // The type is still read from the message itself.
    expect(requestedChartKind(question)).toBe(kind);
  });

  it("leaves a question without a chart phrase as it was", () => {
    expect(buildVisualizationRequestFromQuestion("total revenue by product category and region")?.categoryFields).toEqual([
      "product category",
      "region",
    ]);
  });
});
