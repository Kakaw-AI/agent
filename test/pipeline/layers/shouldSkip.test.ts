import { describe, it, expect } from "vitest";
import { IntentLayer } from "../../../src/pipeline/layers/IntentLayer.js";
import { SqlGenerationLayer } from "../../../src/pipeline/layers/SqlGenerationLayer.js";
import { SqlExecutionLayer } from "../../../src/pipeline/layers/SqlExecutionLayer.js";
import { AnswerLayer } from "../../../src/pipeline/layers/AnswerLayer.js";
import { ChartLayer } from "../../../src/pipeline/layers/ChartLayer.js";
import { SuggestionsLayer } from "../../../src/pipeline/layers/SuggestionsLayer.js";

const baseState = {
  cacheHit: false,
  intentKind: "data_answer",
  wantsVisualization: false,
  visualizationRequest: null,
  visualizationCapabilityDecision: null,
  visualizationValidationStatus: "pending",
  visualizationValidationErrors: [],
  visualizationValidationNarrowedFrom: [],
  visualizationValidationDroppedFields: [],
  narrowedVisualizationReason: null,
  needsImplicitCountMetric: false,
  sql: "",
  errorMessage: null,
  publicErrorMessage: null,
  rowCount: 0,
  rows: [],
  columns: [],
  answer: "",
  chartSpec: null,
  suggestions: [],
  cacheKey: "",
  tokenUsage: null,
  steps: [],
  toolCalls: [],
  repairHistory: [],
} as any;

describe("SqlGenerationLayer.shouldSkip", () => {
  const layer = new SqlGenerationLayer();

  it("skips when cacheHit", () => {
    expect(layer.shouldSkip!({ ...baseState, cacheHit: true })).toBe(true);
  });

  it("skips when intentKind is small_talk", () => {
    expect(layer.shouldSkip!({ ...baseState, intentKind: "small_talk" })).toBe(true);
  });

  it("skips when answer is already set", () => {
    expect(layer.shouldSkip!({ ...baseState, answer: "already answered" })).toBe(true);
  });

  it("skips when errorMessage is set", () => {
    expect(layer.shouldSkip!({ ...baseState, errorMessage: "some error" })).toBe(true);
  });

  it("does not skip in normal data_answer state", () => {
    expect(layer.shouldSkip!(baseState)).toBe(false);
  });
});

describe("SqlExecutionLayer.shouldSkip", () => {
  const layer = new SqlExecutionLayer();

  it("skips when cacheHit", () => {
    expect(layer.shouldSkip!({ ...baseState, cacheHit: true })).toBe(true);
  });

  it("skips when intentKind is small_talk", () => {
    expect(layer.shouldSkip!({ ...baseState, intentKind: "small_talk" })).toBe(true);
  });

  it("skips when errorMessage is set", () => {
    expect(layer.shouldSkip!({ ...baseState, errorMessage: "err" })).toBe(true);
  });

  it("skips when sql is empty", () => {
    expect(layer.shouldSkip!({ ...baseState, sql: "" })).toBe(true);
  });

  it("does not skip when sql is present and no errors", () => {
    expect(layer.shouldSkip!({ ...baseState, sql: "SELECT 1" })).toBe(false);
  });
});

describe("AnswerLayer.shouldSkip", () => {
  const layer = new AnswerLayer();

  it("skips when cacheHit", () => {
    expect(layer.shouldSkip!({ ...baseState, cacheHit: true })).toBe(true);
  });

  it("skips when intentKind is small_talk", () => {
    expect(layer.shouldSkip!({ ...baseState, intentKind: "small_talk" })).toBe(true);
  });

  it("skips when errorMessage is set", () => {
    expect(layer.shouldSkip!({ ...baseState, errorMessage: "err" })).toBe(true);
  });

  it("does not skip in normal state", () => {
    expect(layer.shouldSkip!(baseState)).toBe(false);
  });
});

describe("ChartLayer.shouldSkip", () => {
  const layer = new ChartLayer();

  it("skips when cacheHit", () => {
    expect(layer.shouldSkip!({ ...baseState, cacheHit: true })).toBe(true);
  });

  it("skips when rows is empty", () => {
    expect(layer.shouldSkip!({ ...baseState, rows: [] })).toBe(true);
  });

  it("skips when visualizationValidationStatus is invalid", () => {
    expect(layer.shouldSkip!({ ...baseState, rows: [{ x: 1 }], visualizationValidationStatus: "invalid" })).toBe(true);
  });

  it("skips when visualizationValidationStatus is narrowed", () => {
    expect(layer.shouldSkip!({ ...baseState, rows: [{ x: 1 }], visualizationValidationStatus: "narrowed" })).toBe(true);
  });

  it("does not skip when rows present and status is pending", () => {
    expect(layer.shouldSkip!({ ...baseState, rows: [{ x: 1 }], visualizationValidationStatus: "pending" })).toBe(false);
  });
});

describe("SuggestionsLayer.shouldSkip", () => {
  const layer = new SuggestionsLayer();

  it("skips when cacheHit", () => {
    expect(layer.shouldSkip!({ ...baseState, cacheHit: true })).toBe(true);
  });

  it("skips when intentKind is small_talk", () => {
    expect(layer.shouldSkip!({ ...baseState, intentKind: "small_talk" })).toBe(true);
  });

  it("skips when answer is empty", () => {
    expect(layer.shouldSkip!({ ...baseState, answer: "" })).toBe(true);
  });

  it("does not skip when answer is present", () => {
    expect(layer.shouldSkip!({ ...baseState, answer: "some answer" })).toBe(false);
  });
});

describe("IntentLayer.shouldSkip", () => {
  const layer = new IntentLayer();

  it("skips when cacheHit is true", () => {
    expect(layer.shouldSkip!({ ...baseState, cacheHit: true })).toBe(true);
  });

  it("does not skip when cacheHit is false", () => {
    expect(layer.shouldSkip!({ ...baseState, cacheHit: false })).toBe(false);
  });
});
