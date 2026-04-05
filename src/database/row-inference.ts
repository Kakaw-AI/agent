import { normalizeColumnName } from "./sanitize.js";

export const TEMPORAL_PATTERNS = [
  /\bdate\b/i,
  /\bday\b/i,
  /\bweek\b/i,
  /\bmonth\b/i,
  /\byear\b/i,
  /\btime\b/i,
  /\btrend\b/i,
  /\bover time\b/i,
];

export function getColumnValue(row: Record<string, unknown>, field: string) {
  const normalizedField = normalizeColumnName(field);
  const matchingKey = Object.keys(row).find((key) => normalizeColumnName(key) === normalizedField);
  return matchingKey ? row[matchingKey] : undefined;
}

export function countDistinctRowValues(rows: Array<Record<string, unknown>>, field: string) {
  const normalizedField = normalizeColumnName(field);
  const values = new Set<string>();

  for (const row of rows) {
    const matchingKey = Object.keys(row).find(
      (key) => normalizeColumnName(key) === normalizedField,
    );

    if (!matchingKey) {
      continue;
    }

    const value = row[matchingKey];
    if (value === null || value === undefined || String(value).trim() === "") {
      continue;
    }

    values.add(String(value).trim().toLowerCase());
  }

  return values.size;
}

export function hasNonEmptyStringValue(rows: Array<Record<string, unknown>>, field: string) {
  return rows.some((row) => {
    const value = getColumnValue(row, field);
    return typeof value === "string" && value.trim() !== "";
  });
}

export function hasNumericValue(rows: Array<Record<string, unknown>>, field: string) {
  return rows.some((row) => typeof getColumnValue(row, field) === "number");
}

export function isTemporalField(field: string, rows: Array<Record<string, unknown>>) {
  if (TEMPORAL_PATTERNS.some((pattern) => pattern.test(field))) {
    return true;
  }

  return rows.some((row) => {
    const value = getColumnValue(row, field);
    if (value instanceof Date) {
      return true;
    }
    if (typeof value === "string") {
      return !Number.isNaN(Date.parse(value));
    }
    return false;
  });
}

export function inferNumericColumns(columns: string[], rows: Array<Record<string, unknown>>) {
  return columns.filter((column) => hasNumericValue(rows, column));
}

export function inferTextColumns(columns: string[], rows: Array<Record<string, unknown>>) {
  return columns.filter((column) => hasNonEmptyStringValue(rows, column));
}
