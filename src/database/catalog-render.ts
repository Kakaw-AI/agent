import type { DatabaseCatalogTable } from "../types.js";

/**
 * Rendering of the schema catalog as it appears in the SQL system prompt.
 *
 * Extracted so the size estimate recorded at sync time is derived from the
 * exact same string the model will eventually see. Estimating from a separate
 * approximation would drift the moment the prompt format changes, and the
 * subsetting threshold depends on that number being right.
 */

/**
 * Characters per token for identifier-dense text.
 *
 * Below the usual ~4 because snake_case names tokenize badly: `total_amount`
 * is three tokens for twelve characters. Calibrate against a real tokenizer
 * before tightening the subsetting threshold.
 */
const CHARS_PER_TOKEN = 3.6;

const NUMERIC_TYPE = /int|numeric|decimal|real|double|float|serial|money|number|bool/i;
const MAX_SAMPLE_CHARS = 40;

/**
 * Up to three stored values for a text or date column, e.g. `e.g. 'Delivered', 'Shipped'`.
 *
 * Without them the model guesses filter values from the question: it writes
 * `status = 'cancelled'` when the data says 'Cancelled', and the query runs
 * fine and returns nothing. Numbers are skipped because a sample of them says
 * little, and so are redacted or binary values.
 */
function renderSampleValues(column: DatabaseCatalogTable["columns"][number]): string {
  if (column.isPrimaryKey || NUMERIC_TYPE.test(column.dataType) || !column.sampleValues) {
    return "";
  }
  const seen = new Set<string>();
  for (const sample of column.sampleValues) {
    if (sample === null || sample === undefined || typeof sample === "object") continue;
    const text = String(sample);
    if (!text.trim() || text === "[redacted]" || text.startsWith("[binary:")) continue;
    seen.add(text.length > MAX_SAMPLE_CHARS ? `${text.slice(0, MAX_SAMPLE_CHARS)}...` : text);
    if (seen.size === 3) break;
  }
  if (seen.size === 0) return "";
  return `, e.g. ${[...seen].map((text) => `'${text.replace(/'/g, "''")}'`).join(", ")}`;
}

export function renderCatalogLine(table: DatabaseCatalogTable): string {
  const columns = table.columns
    .map(
      (column) =>
        `${column.name} (${column.dataType}${column.isPrimaryKey ? ", PK" : ""}${column.isNullable ? "" : ", NOT NULL"}${renderSampleValues(column)})`,
    )
    .join(", ");

  const relationships =
    table.foreignKeys.length > 0
      ? table.foreignKeys
          .map((fk) => `${fk.sourceColumn} -> ${fk.targetTable}.${fk.targetColumn}`)
          .join("; ")
      : "none";

  const tablePrefix = table.schemaName ? `${table.schemaName}.` : "";
  return `${tablePrefix}${table.name}: ${columns}. relationships: ${relationships}`;
}

export function renderCatalog(tables: DatabaseCatalogTable[]): string {
  return tables.map(renderCatalogLine).join("\n");
}

export function countCatalogColumns(tables: DatabaseCatalogTable[]): number {
  return tables.reduce((total, table) => total + table.columns.length, 0);
}

/** Approximate tokens the rendered catalog will occupy in the system prompt. */
export function estimateCatalogTokens(tables: DatabaseCatalogTable[]): number {
  return Math.ceil(renderCatalog(tables).length / CHARS_PER_TOKEN);
}
