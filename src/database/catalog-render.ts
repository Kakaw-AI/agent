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

export function renderCatalogLine(table: DatabaseCatalogTable): string {
  const columns = table.columns
    .map(
      (column) =>
        `${column.name} (${column.dataType}${column.isPrimaryKey ? ", PK" : ""}${column.isNullable ? "" : ", NOT NULL"})`,
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
