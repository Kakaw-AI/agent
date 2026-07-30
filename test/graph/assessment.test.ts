import { describe, expect, it } from "vitest";
import {
  assessVisualizationSqlDraft,
  buildVisualizationSqlExhaustedOutcome,
} from "../../src/graph/qa/assessment.js";
import type { VisualizationRequest } from "../../src/types.js";

function vizRequest(
  overrides: Partial<VisualizationRequest> = {},
): VisualizationRequest {
  return {
    categoryFields: ["customer_id"],
    metricField: null,
    seriesField: null,
    groupField: null,
    networkViewRequested: false,
    ...overrides,
  };
}

describe("assessVisualizationSqlDraft alias matching", () => {
  it("accepts aliases that spell the requested field differently", () => {
    // The model was told `customer_id` and wrote `customerId`. Rejecting this
    // used to regenerate SQL that was already correct.
    for (const alias of ["customer_id", "customerId", "customer_ids", "Customer_ID"]) {
      const assessment = assessVisualizationSqlDraft({
        sql: `SELECT ${alias} FROM orders`,
        visualizationRequest: vizRequest(),
      });
      expect(assessment.missingFields, `alias ${alias}`).toEqual([]);
      expect(assessment.ok, `alias ${alias}`).toBe(true);
    }
  });

  it("still rejects an alias that names a genuinely different field", () => {
    const assessment = assessVisualizationSqlDraft({
      sql: "SELECT customer FROM orders",
      visualizationRequest: vizRequest(),
    });
    expect(assessment.ok).toBe(false);
    expect(assessment.missingFields).toEqual(["customer_id"]);
  });

  it("passes straight through when no visualization was requested", () => {
    const assessment = assessVisualizationSqlDraft({
      sql: "SELECT anything FROM orders",
      visualizationRequest: null,
    });
    expect(assessment.ok).toBe(true);
  });
});

describe("buildVisualizationSqlExhaustedOutcome", () => {
  it("names the unmatched field and its candidates", () => {
    const outcome = buildVisualizationSqlExhaustedOutcome(
      ["missing field"],
      [{ field: "regoin", candidates: ["public.orders.sales_region"] }],
    );
    expect(outcome.answer).toContain('"regoin"');
    expect(outcome.answer).toContain("sales_region");
  });

  it("falls back to the generic message when there is nothing to suggest", () => {
    const outcome = buildVisualizationSqlExhaustedOutcome(["missing field"]);
    expect(outcome.answer).toContain("narrow the request");
  });
});
