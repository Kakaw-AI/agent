import { countDistinctRowValues } from "../database/row-inference.js";
import { normalizeColumnName } from "../database/sanitize.js";
import type {
  VisualizationCapabilityDecision,
  VisualizationRequest,
  VisualizationRequestInput,
  VisualizationValidationResult,
} from "../types.js";
import { dedupeFieldNames } from "../utils/text.js";
import type { VisualizationValidationInput } from "./types.js";

const PIE_CATEGORY_LIMIT = 8;
const GROUPED_PRIMARY_CATEGORY_LIMIT = 12;
const GROUPED_SERIES_LIMIT = 6;

export function getRequiredVisualizationFields(request: VisualizationRequest) {
  return dedupeFieldNames([
    ...request.categoryFields,
    request.seriesField,
    request.groupField,
    request.metricField,
  ]);
}

export function normalizeVisualizationRequest(
  input: VisualizationRequestInput,
): VisualizationRequest {
  const rawCategoryFields = Array.isArray(input.categoryFields)
    ? input.categoryFields
    : typeof input.categoryFields === "string"
      ? [input.categoryFields]
      : [];

  return {
    categoryFields: rawCategoryFields.flatMap((field) => {
      if (typeof field !== "string") {
        return [];
      }

      const normalized = field.trim();
      return normalized ? [normalized] : [];
    }),
    metricField: typeof input.metricField === "string" ? input.metricField.trim() || null : null,
    seriesField: typeof input.seriesField === "string" ? input.seriesField.trim() || null : null,
    groupField: typeof input.groupField === "string" ? input.groupField.trim() || null : null,
    networkViewRequested: input.networkViewRequested === true,
  };
}

export function decideVisualizationCapability(
  request: VisualizationRequest | null,
): VisualizationCapabilityDecision | null {
  if (!request) {
    return null;
  }

  if (request.networkViewRequested) {
    return {
      kind: "unsupported_needs_narrowing",
      supported: false,
      reason: "Network and relationship visualizations are not supported by the current renderer.",
      requestedCategoryFields: [...request.categoryFields],
      metricField: request.metricField,
      seriesField: request.seriesField,
      groupField: request.groupField,
      networkViewRequested: true,
    };
  }

  const baseDecision = {
    reason: null,
    requestedCategoryFields: [...request.categoryFields],
    metricField: request.metricField,
    seriesField: request.seriesField,
    groupField: request.groupField,
    networkViewRequested: false,
  };

  if (request.seriesField) {
    return {
      kind: "grouped_bar",
      supported: true,
      ...baseDecision,
    };
  }

  return {
    kind: "simple_xy_chart",
    supported: true,
    ...baseDecision,
  };
}

export function validateVisualizationResult(
  input: VisualizationValidationInput,
): VisualizationValidationResult {
  const requiredFields = getRequiredVisualizationFields(input.request);
  const availableColumns = new Set(input.columns.map((column) => normalizeColumnName(column)));
  const droppedFields = requiredFields.filter(
    (field) => !availableColumns.has(normalizeColumnName(field)),
  );
  const errors = droppedFields.map(
    (field) => `The result set is missing requested visualization field "${field}".`,
  );
  const narrowedFrom: string[] = [];

  const capabilityKind = input.capabilityDecision?.kind ?? decideVisualizationCapability(input.request)?.kind;

  if (
    input.request.networkViewRequested ||
    input.capabilityDecision?.supported === false ||
    capabilityKind === "unsupported_needs_narrowing" ||
    capabilityKind === "network_graph"
  ) {
    errors.push("Network and relationship visualizations are not supported.");
    narrowedFrom.push("network_graph");
  }

  if (
    (capabilityKind === "grouped_bar" || capabilityKind === "stacked_bar") &&
    input.request.seriesField &&
    !availableColumns.has(normalizeColumnName(input.request.seriesField))
  ) {
    errors.push(
      `The result set must include the requested series field "${input.request.seriesField}".`,
    );
  }

  if (
    (capabilityKind === "grouped_bar" || capabilityKind === "stacked_bar") &&
    input.request.categoryFields[0]
  ) {
    const primaryCategoryCount = countDistinctRowValues(input.rows, input.request.categoryFields[0]);
    if (primaryCategoryCount > GROUPED_PRIMARY_CATEGORY_LIMIT) {
      errors.push(
        `The result has too many primary categories (${primaryCategoryCount}) for a grouped chart. Please narrow it to ${GROUPED_PRIMARY_CATEGORY_LIMIT} or fewer.`,
      );
      narrowedFrom.push(input.request.categoryFields[0]);
    }
  }

  if (
    (capabilityKind === "grouped_bar" || capabilityKind === "stacked_bar") &&
    input.request.seriesField
  ) {
    const seriesCount = countDistinctRowValues(input.rows, input.request.seriesField);
    if (seriesCount > GROUPED_SERIES_LIMIT) {
      errors.push(
        `The result has too many series (${seriesCount}) for the renderer. Please narrow it to ${GROUPED_SERIES_LIMIT} or fewer.`,
      );
      narrowedFrom.push(input.request.seriesField);
    }
  }

  if (capabilityKind === "simple_xy_chart" && input.request.categoryFields[0]) {
    const categoryCount = countDistinctRowValues(input.rows, input.request.categoryFields[0]);
    if (categoryCount > PIE_CATEGORY_LIMIT && /\bshare|composition|breakdown|portion|pie\b/i.test(input.request.metricField ?? "")) {
      errors.push(
        `The result has too many categories (${categoryCount}) for a pie chart. Please narrow it to ${PIE_CATEGORY_LIMIT} or fewer.`,
      );
      narrowedFrom.push(input.request.categoryFields[0]);
    }
  }

  return {
    status: narrowedFrom.length > 0 ? "narrowed" : errors.length > 0 ? "invalid" : "valid",
    errors,
    narrowedFrom: dedupeFieldNames(narrowedFrom),
    droppedFields,
  };
}

export function buildVisualizationNarrowingAnswer(input: {
  request: VisualizationRequest | null;
  reason: string | null;
  validation?: VisualizationValidationResult | null;
}) {
  const fallback =
    "I can't render that requested visualization cleanly here. If you want, I can narrow it to a simpler supported chart.";
  const reason = input.reason?.trim() || input.validation?.errors[0]?.trim() || "";

  if (!reason) {
    return fallback;
  }

  if (/network|relationship/i.test(reason)) {
    return "I can't render a network graph here. If you want, I can narrow this to a grouped bar chart using one category and one series.";
  }

  if (/too many/i.test(reason)) {
    return "I can render this as a chart, but the current result has too many categories or series for a readable view. If you want, I can narrow it to the top groups first.";
  }

  return fallback;
}
