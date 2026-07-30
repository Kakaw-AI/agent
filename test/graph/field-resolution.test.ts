import { describe, expect, it } from "vitest";
import { buildSchemaIndex } from "../../src/database/schema-index.js";
import {
  RESERVED_VISUALIZATION_TOKENS,
  describeFieldResolution,
  didYouMeanFromEntries,
  resolveVisualizationRequestFields,
} from "../../src/graph/field-resolution.js";
import type {
  DatabaseCatalogColumn,
  DatabaseKnowledgeRuntime,
  VisualizationRequest,
} from "../../src/types.js";

function col(name: string, dataType = "text"): DatabaseCatalogColumn {
  return {
    name,
    normalizedName: name,
    dataType,
    isNullable: true,
    isPrimaryKey: false,
    ordinalPosition: 1,
  };
}

const KNOWLEDGE: DatabaseKnowledgeRuntime = {
  schemaFingerprint: "fp-fields",
  summary: "",
  tables: [
    {
      schemaName: "public",
      name: "orders",
      rowCount: 100,
      columns: [
        col("customer_id", "integer"),
        col("total_amount", "numeric"),
        col("order_date", "date"),
        col("sales_region"),
      ],
      indexes: [],
      foreignKeys: [],
    },
  ],
  knowledgeDocuments: [],
};

const INDEX = buildSchemaIndex(KNOWLEDGE);

function request(overrides: Partial<VisualizationRequest> = {}): VisualizationRequest {
  return {
    categoryFields: [],
    metricField: null,
    seriesField: null,
    groupField: null,
    networkViewRequested: false,
    ...overrides,
  };
}

describe("reserved tokens", () => {
  it("passes aggregation and layout placeholders through untouched", () => {
    // These are invented by the question parser, not column names. Resolving
    // "total" to total_amount would turn a SUM into a column reference.
    for (const token of ["count", "total", "sum", "average", "time", "series", "group"]) {
      expect(RESERVED_VISUALIZATION_TOKENS.has(token)).toBe(true);
    }

    const result = resolveVisualizationRequestFields(
      request({ categoryFields: ["time"], metricField: "total", seriesField: "series" }),
      INDEX,
    );

    expect(result?.request.metricField).toBe("total");
    expect(result?.request.categoryFields).toEqual(["time"]);
    expect(result?.request.seriesField).toBe("series");
    expect(result?.corrections).toEqual([]);
    expect(result?.entries.every((entry) => entry.kind === "reserved")).toBe(true);
  });
});

describe("resolveVisualizationRequestFields", () => {
  it("corrects a misspelled column and records the correction", () => {
    const result = resolveVisualizationRequestFields(
      request({ categoryFields: ["custmer_id"] }),
      INDEX,
    );

    expect(result?.request.categoryFields).toEqual(["customer_id"]);
    expect(result?.corrections).toEqual([
      { from: "custmer_id", to: "customer_id" },
    ]);
    expect(result?.entries[0]?.kind).toBe("corrected");
  });

  it("canonicalizes casing and separators without calling it a correction", () => {
    const result = resolveVisualizationRequestFields(
      request({ categoryFields: ["CustomerId"] }),
      INDEX,
    );

    expect(result?.request.categoryFields).toEqual(["customer_id"]);
    expect(result?.corrections).toEqual([]);
    expect(result?.entries[0]?.kind).toBe("unchanged");
  });

  it("leaves a natural-language phrase completely alone", () => {
    // The regression guard: where fuzzy matching has nothing useful to say,
    // behaviour must be identical to before this feature existed.
    const original = request({ categoryFields: ["the top selling artist"] });
    const result = resolveVisualizationRequestFields(original, INDEX);

    expect(result?.request.categoryFields).toEqual(["the top selling artist"]);
    expect(result?.corrections).toEqual([]);
    expect(result?.didYouMean).toEqual([]);
  });

  it("suggests rather than rewrites when the user named part of a column", () => {
    const result = resolveVisualizationRequestFields(
      request({ categoryFields: ["regoin"] }),
      INDEX,
    );

    expect(result?.request.categoryFields).toEqual(["regoin"]);
    expect(result?.corrections).toEqual([]);
    expect(result?.didYouMean).toEqual([
      { field: "regoin", candidates: ["public.orders.sales_region"] },
    ]);
  });

  it("returns null when there is no visualization request", () => {
    expect(resolveVisualizationRequestFields(null, INDEX)).toBeNull();
  });

  it("resolves every slot, not just categories", () => {
    const result = resolveVisualizationRequestFields(
      request({ metricField: "totl_amount", groupField: "ordr_date" }),
      INDEX,
    );

    expect(result?.request.metricField).toBe("total_amount");
    expect(result?.request.groupField).toBe("order_date");
  });
});

describe("reporting helpers", () => {
  it("summarizes corrections for the step log", () => {
    const result = resolveVisualizationRequestFields(
      request({ categoryFields: ["custmer_id"] }),
      INDEX,
    );
    expect(describeFieldResolution(result)).toContain('"custmer_id" as "customer_id"');
  });

  it("summarizes an unresolved field with its candidates", () => {
    const result = resolveVisualizationRequestFields(
      request({ categoryFields: ["regoin"] }),
      INDEX,
    );
    expect(describeFieldResolution(result)).toContain("sales_region");
  });

  it("says nothing when everything matched cleanly", () => {
    const result = resolveVisualizationRequestFields(
      request({ categoryFields: ["customer_id"] }),
      INDEX,
    );
    expect(describeFieldResolution(result)).toBeNull();
  });

  it("rebuilds the candidate list from entries alone", () => {
    const result = resolveVisualizationRequestFields(
      request({ categoryFields: ["regoin"] }),
      INDEX,
    );
    expect(didYouMeanFromEntries(result!.entries)).toEqual(result!.didYouMean);
  });
});
