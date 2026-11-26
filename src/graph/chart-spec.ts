import {
  countDistinctRowValues,
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

type ChartKind = FallbackChartSpec["kind"];

/** Pie needs few slices to stay readable; matches the renderer's own cap. */
const PIE_SLICE_LIMIT = 8;
/** Grouped bars stay readable up to here; past it a heatmap shows the grid. */
const GROUPED_SERIES_LIMIT = 6;
const GROUPED_CATEGORY_LIMIT = 12;
const ID_COLUMN = /(^|_)(id|uuid|key|zip|phone)$/i;

/**
 * The chart type the user named, if any: "show that as a bar chart", "as a
 * pie", "histogram of prices". A chart word must follow the type so data words
 * ("order lines", "bar stools") do not count.
 */
export function requestedChartKind(text: string): ChartKind | null {
  const named = text.match(/\b(bar|column|line|pie|donut|doughnut|scatter)\s*(?:charts?|graphs?|plots?)\b/i)?.[1]
    ?? text.match(/\bas (?:an? )?(bars?|line|pie|donut|doughnut)\b/i)?.[1]
    ?? text.match(/\b(histogram|scatterplot|heat ?map|bubble|combo|horizontal bar)\b/i)?.[1];
  if (!named) return null;
  const word = named.toLowerCase();
  if (word.startsWith("bar") || word === "column") return "bar";
  if (word === "pie" || word === "donut" || word === "doughnut") return "pie";
  if (word.startsWith("scatter")) return "scatter";
  if (word.startsWith("heat")) return "heatmap";
  if (word === "horizontal bar") return "hbar";
  return word as ChartKind;
}

export function planChartSpecDeterministically(input: DeterministicChartSpecInput): FallbackChartSpec | null {
  const { question, columns, rows, visualizationRequest } = input;
  const requested = input.requestedKind !== undefined ? input.requestedKind : requestedChartKind(question);

  if (rows.length === 0 || columns.length === 0) {
    return null;
  }

  // Integer years and months are axes, not measures; ids are neither.
  const timeNumbers = inferNumericColumns(columns, rows).filter(
    (column) =>
      /(^|_)(year|month|quarter|week)s?$/i.test(column) &&
      rows.every((row) => row[column] == null || Number.isInteger(row[column])),
  );
  const numericColumns = inferNumericColumns(columns, rows).filter(
    (column) => !timeNumbers.includes(column) && !ID_COLUMN.test(column),
  );
  const dimensions = [...inferTextColumns(columns, rows), ...timeNumbers];

  // "top 5 products by units sold": a "by" that names a number, next to text that
  // could label the rows, is what they are ranked by, not the x axis.
  const named = findColumnByName(columns, visualizationRequest?.categoryFields[0] ?? null);
  const rankedBy = named && numericColumns.includes(named) && dimensions.length > 0 ? named : null;

  const metricField =
    findColumnByName(columns, visualizationRequest?.metricField ?? null) ??
    rankedBy ??
    numericColumns.find((column) => /(total|count|sum|amount|revenue|sales|score|value)/i.test(column)) ??
    numericColumns[0] ??
    null;
  const otherMetrics = numericColumns.filter((column) => column !== metricField);

  // A time column is the x axis when there is one; the other dimension is the series.
  const requestedCategory = rankedBy ? null : named;
  const categoryField =
    requestedCategory ?? dimensions.find((column) => isTemporalField(column, rows)) ?? dimensions[0] ?? null;
  // A second text column is a series only when categories repeat across rows;
  // one row per category means it is just an attribute (an email, a city).
  const seriesField =
    findColumnByName(columns, visualizationRequest?.seriesField ?? null) ??
    (categoryField && countDistinctRowValues(rows, categoryField) < rows.length
      ? dimensions.find((column) => column !== categoryField) ?? null
      : null);

  const explicitMetricComparison =
    extractMetricComparisonFields(question, numericColumns) ??
    ((requested === "scatter" || requested === "bubble") && numericColumns.length >= 2 ? numericColumns.slice(0, 2) : null);

  if (explicitMetricComparison) {
    const [xField, yField] = explicitMetricComparison;
    const sizeField = numericColumns.find((column) => column !== xField && column !== yField) ?? null;
    return pointChart(xField, yField, sizeField, categoryField, rows);
  }

  if (requested === "histogram" && metricField) {
    return histogram(metricField, rows);
  }

  if (!categoryField || !metricField) {
    if (numericColumns.length >= 2) {
      return pointChart(numericColumns[0], numericColumns[1], numericColumns[2] ?? null, null, rows);
    }
    return metricField ? histogram(metricField, rows) : null;
  }

  const axes = {
    title: `${toReadableLabel(metricField)} by ${toReadableLabel(categoryField)}`,
    xField: categoryField,
    yField: metricField,
    xLabel: toReadableLabel(categoryField),
    yLabel: toReadableLabel(metricField),
  };
  const overTime = isTemporalField(categoryField, rows);

  if (seriesField) {
    const categoryCount = countDistinctRowValues(rows, categoryField);
    const seriesCount = countDistinctRowValues(rows, seriesField);
    const series = { seriesField, legendLabel: toReadableLabel(seriesField) };
    const title = `${axes.title} and ${toReadableLabel(seriesField)}`;
    const fitsBars = seriesCount <= GROUPED_SERIES_LIMIT && categoryCount <= GROUPED_CATEGORY_LIMIT;

    if (requested === "heatmap" || (!requested && !fitsBars && !(overTime && seriesCount <= GROUPED_SERIES_LIMIT))) {
      return { kind: "heatmap", ...axes, ...series, title, data: rows.slice(0, 400) };
    }
    if (requested === "line" || (!requested && overTime)) {
      return { kind: "line", ...axes, ...series, title, data: rows.slice(0, 300) };
    }
    const stacked =
      /\bstack(?:ed)?\b/i.test(question) || normalizeColumnName(visualizationRequest?.groupField ?? "") === "stack";
    return { kind: "bar", ...axes, ...series, title, stacked, data: rows.slice(0, 50) };
  }

  // A chart type the user named wins whenever the data can be drawn that way.
  const fitsPie = rows.length <= PIE_SLICE_LIMIT && rows.every((row) => (Number(row[metricField]) || 0) >= 0);
  if (requested === "bar" || requested === "hbar" || requested === "line" || (requested === "pie" && fitsPie)) {
    return { kind: requested, ...axes, data: rows.slice(0, requested === "hbar" ? 25 : 20) };
  }

  const secondMetric = otherMetrics[0] ?? null;
  if (requested === "combo" && secondMetric) {
    return combo(axes, secondMetric, rows);
  }

  if (overTime) {
    // Two measures over time: bars and a line on separate axes, so a small
    // count is not flattened against revenue.
    return secondMetric ? combo(axes, secondMetric, rows) : { kind: "line", ...axes, data: rows.slice(0, 300) };
  }

  if (otherMetrics.length >= 2 && rows.length >= 4) {
    return pointChart(metricField, otherMetrics[0], otherMetrics[1], categoryField, rows);
  }
  if (secondMetric) {
    return combo(axes, secondMetric, rows);
  }

  const shareQuestion =
    /\b(share|percent(age)?|proportion|split|breakdown|composition|mix)\b/i.test(question) ||
    /(pct|percent|share|ratio)/i.test(metricField);
  if (shareQuestion && fitsPie && rows.length >= 2) {
    return { kind: "pie", ...axes, data: rows };
  }

  // Ranked horizontal bars read long names and many rows; a short list keeps columns.
  const longLabels = rows.some((row) => String(row[categoryField] ?? "").length > 12);
  return rows.length > 6 || longLabels
    ? { kind: "hbar", ...axes, data: rows.slice(0, 25) }
    : { kind: "bar", ...axes, data: rows.slice(0, 20) };
}

type Axes = Pick<FallbackChartSpec, "title" | "xField" | "yField" | "xLabel" | "yLabel">;

function combo(axes: Axes, y2Field: string, rows: Array<Record<string, unknown>>): FallbackChartSpec {
  return {
    kind: "combo",
    ...axes,
    title: `${axes.yLabel} and ${toReadableLabel(y2Field)} by ${axes.xLabel}`,
    y2Field,
    y2Label: toReadableLabel(y2Field),
    data: rows.slice(0, 24),
  };
}

function pointChart(
  xField: string,
  yField: string,
  sizeField: string | null,
  labelField: string | null,
  rows: Array<Record<string, unknown>>,
): FallbackChartSpec {
  return {
    kind: sizeField ? "bubble" : "scatter",
    title: `${toReadableLabel(yField)} vs ${toReadableLabel(xField)}${sizeField ? `, sized by ${toReadableLabel(sizeField)}` : ""}`,
    xField,
    yField,
    xLabel: toReadableLabel(xField),
    yLabel: toReadableLabel(yField),
    sizeField,
    sizeLabel: sizeField ? toReadableLabel(sizeField) : null,
    labelField,
    data: rows.slice(0, 100),
  };
}

function histogram(xField: string, rows: Array<Record<string, unknown>>): FallbackChartSpec {
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

export function buildFallbackChartSpec(input: {
  question: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}): FallbackChartSpec | null {
  return planChartSpecDeterministically(input);
}
