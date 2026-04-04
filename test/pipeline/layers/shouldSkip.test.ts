import { describe, it, expect } from "vitest";
import { IntentLayer } from "../../../src/pipeline/layers/IntentLayer.js";

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

describe("IntentLayer.shouldSkip", () => {
  const layer = new IntentLayer();

  it("skips when cacheHit is true", () => {
    expect(layer.shouldSkip!({ ...baseState, cacheHit: true })).toBe(true);
  });

  it("does not skip when cacheHit is false", () => {
    expect(layer.shouldSkip!({ ...baseState, cacheHit: false })).toBe(false);
  });
});
