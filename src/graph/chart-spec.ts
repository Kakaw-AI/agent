import {
  hasNonEmptyStringValue,
  hasNumericValue,
  inferNumericColumns,
  inferTextColumns,
  isTemporalField,
} from "../database/row-inference.js";
import {
  IDENTIFIER_THRESHOLDS,
  identifierTokens,
  identifiersMatch,
} from "../database/identifier-match.js";
import { findColumnByName, normalizeColumnName } from "../database/sanitize.js";
import { tokenizeQuestion } from "../llm/intent/text.js";
import { toReadableLabel } from "../utils/text.js";
import type { DeterministicChartSpecInput, FallbackChartSpec } from "./types.js";

function extractMetricComparisonFields(question: string, numericColumns: string[]) {
  const questionTokens = tokenizeQuestion(question);
  // Slides a window the width of the column's own token count across the
  // question and scores it. A literal regex over the column name misses
  // "compare total_reveneu vs order_count" entirely.
  const matchedColumns = numericColumns.filter((column) => {
    const width = Math.max(1, identifierTokens(column).length);
    for (let start = 0; start + width <= questionTokens.length; start += 1) {
      const window = questionTokens.slice(start, start + width).join("_");
      if (identifiersMatch(window, column, IDENTIFIER_THRESHOLDS.autoAccept)) {
        return true;
      }
    }
    return false;
  });

  if (matchedColumns.length >= 2 && /\b(vs|versus|compare|comparison|correlation|relationship)\b/i.test(question)) {
    return matchedColumns.slice(0, 2);
  }

  return null;
}

export function planChartSpecDeterministically(
  input: DeterministicChartSpecInput,
): (FallbackChartSpec & {
  seriesField?: string | null;
  stacked?: boolean;
  legendLabel?: string | null;
}) | null {
  const { question, columns, rows, visualizationRequest } = input;

  if (rows.length === 0 || columns.length === 0) {
    return null;
  }

  const numericColumns = inferNumericColumns(columns, rows);
  const textColumns = inferTextColumns(columns, rows);

  const categoryField =
    findColumnByName(columns, visualizationRequest?.categoryFields[0] ?? null) ?? textColumns[0] ?? null;
  const seriesField =
    findColumnByName(columns, visualizationRequest?.seriesField ?? null) ?? null;
  const metricField =
    findColumnByName(columns, visualizationRequest?.metricField ?? null) ??
    numericColumns.find((column) => /(total|count|sum|amount|revenue|score|value)/i.test(column)) ??
    numericColumns[0] ??
    null;
  const explicitMetricComparison = extractMetricComparisonFields(question, numericColumns);

  if (explicitMetricComparison) {
    const [xField, yField] = explicitMetricComparison;
    return {
      kind: "scatter",
      title: `${toReadableLabel(yField)} vs ${toReadableLabel(xField)}`,
      xField,
      yField,
      xLabel: toReadableLabel(xField),
      yLabel: toReadableLabel(yField),
      data: rows.slice(0, 50),
    };
  }

  if (
    categoryField &&
    metricField &&
    seriesField &&
    hasNonEmptyStringValue(rows, categoryField) &&
    hasNonEmptyStringValue(rows, seriesField) &&
    hasNumericValue(rows, metricField)
  ) {
    const stacked =
      /\bstack(?:ed)?\b/i.test(question) ||
      normalizeColumnName(visualizationRequest?.groupField ?? "") === "stack";

    return {
      kind: "bar",
      title: `${toReadableLabel(metricField)} by ${toReadableLabel(categoryField)}`,
      xField: categoryField,
      yField: metricField,
      xLabel: toReadableLabel(categoryField),
      yLabel: toReadableLabel(metricField),
      seriesField,
      stacked,
      legendLabel: toReadableLabel(seriesField),
      data: rows.slice(0, 50),
    };
  }

  if (
    categoryField &&
    metricField &&
    hasNonEmptyStringValue(rows, categoryField) &&
    hasNumericValue(rows, metricField)
  ) {
    return {
      kind: isTemporalField(categoryField, rows) ? "line" : "bar",
      title: `${toReadableLabel(metricField)} by ${toReadableLabel(categoryField)}`,
      xField: categoryField,
      yField: metricField,
      xLabel: toReadableLabel(categoryField),
      yLabel: toReadableLabel(metricField),
      data: rows.slice(0, 20),
    };
  }

  if (numericColumns.length >= 2) {
    const [xField, yField] = numericColumns;
    return {
      kind: "scatter",
      title: `${toReadableLabel(yField)} vs ${toReadableLabel(xField)}`,
      xField,
      yField,
      xLabel: toReadableLabel(xField),
      yLabel: toReadableLabel(yField),
      data: rows.slice(0, 50),
    };
  }

  if (numericColumns.length === 1) {
    const [xField] = numericColumns;
    return {
      kind: "histogram",
      title: `Distribution of ${toReadableLabel(xField)}`,
      xField,
      yField: xField,
      xLabel: toReadableLabel(xField),
      yLabel: "Count",
      data: rows.slice(0, 100),
    };
  }

  return null;
}

export function buildFallbackChartSpec(input: {
  question: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}): FallbackChartSpec | null {
  return planChartSpecDeterministically(input);
}
