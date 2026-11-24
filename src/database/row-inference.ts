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

function getColumnValue(row: Record<string, unknown>, field: string) {
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

const TEMPORAL_NAME_TOKENS = new Set(["date", "day", "week", "month", "year", "quarter", "time", "period", "hour", "at"]);
/** ISO-ish dates and periods: 2026, 2026-07, 2026-07-14, 2026-Q3, 2026-W12. */
const TEMPORAL_VALUE = /^\d{4}(?:-(?:\d{2}|Q[1-4]|W\d{1,2})(?:-\d{2})?)?(?:[T ][\d:.]+Z?)?$/i;

export function isTemporalField(field: string, rows: Array<Record<string, unknown>>) {
  // Split on "_" too: "\bdate\b" never matched "order_date".
  if (field.toLowerCase().split(/[^a-z0-9]+/).some((token) => TEMPORAL_NAME_TOKENS.has(token))) {
    return true;
  }

  // Every value must look like a date. Date.parse accepted "Product 1" as 2001-01-01.
  const values = rows.map((row) => getColumnValue(row, field)).filter((value) => value != null && value !== "");
  return (
    values.length > 0 &&
    values.every((value) => value instanceof Date || (typeof value === "string" && TEMPORAL_VALUE.test(value.trim())))
  );
}

export function inferNumericColumns(columns: string[], rows: Array<Record<string, unknown>>) {
  return columns.filter((column) => hasNumericValue(rows, column));
}

export function inferTextColumns(columns: string[], rows: Array<Record<string, unknown>>) {
  return columns.filter((column) => hasNonEmptyStringValue(rows, column));
}
