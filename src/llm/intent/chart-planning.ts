import { TEMPORAL_PATTERNS } from "../../database/row-inference.js";
import { IntentDecision } from "../../graph/types.js";

export function needsImplicitCountMetric(
  intent: IntentDecision,
  availableColumns: string[],
) {
  if (
    intent.kind !== "explicit_visualization" &&
    intent.kind !== "visualization_followup"
  ) {
    return false;
  }

  const likelyCategoryColumns = availableColumns.filter((column) =>
    /\b(country|city|state|region|category|type|name|status|provider)\b/i.test(
      column,
    ),
  );

  return likelyCategoryColumns.length > 0;
}

export function shouldAutoPlanChart(input: {
  question: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}) {
  const { question, columns, rows } = input;
  if (rows.length < 2 || columns.length < 2) {
    return false;
  }

  const numericColumns = columns.filter((column) =>
    rows.some((row) => typeof row[column] === "number"),
  );
  const textColumns = columns.filter((column) =>
    rows.some((row) => typeof row[column] === "string"),
  );

  if (numericColumns.length === 0) {
    return false;
  }

  if (rows.length === 1) {
    return false;
  }

  if (numericColumns.length === 1 && textColumns.length === 1) {
    if (rows.length > 12) {
      return false;
    }

    return /\b(top|bottom|by|compare|comparison|ranking|rank|trend|over time)\b/i.test(
      question,
    );
  }

  if (numericColumns.length >= 2) {
    return /\b(compare|comparison|relationship|correlation|distribution|trend)\b/i.test(
      question,
    );
  }

  return TEMPORAL_PATTERNS.some((pattern) => pattern.test(question));
}
