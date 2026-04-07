import { BaseSqlPromptBuilder } from "../SqlPromptBuilder.js";

export class SqliteSqlPromptBuilder extends BaseSqlPromptBuilder {
  protected buildDialectInstructions(): string[] {
    return [
      "--- ROLE & OUTPUT FORMAT ---",
      "You are an expert SQL analyst writing highly optimized queries for SQLite.",
      `You MUST return a valid JSON object strictly matching this schema: {"sql": "string", "rationale": "string"}.`,
      "Do NOT wrap the JSON output in markdown code blocks (e.g., ```json). Return raw JSON only.",

      "--- SECURITY & EXECUTION CONSTRAINTS ---",
      "Generate EXACTLY ONE valid, executable read-only SELECT statement.",
      "NEVER output INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, ATTACH, DETACH, PRAGMA, or any data manipulation/admin commands.",
      "SQLite does not support schema-qualified table names (e.g., never use 'dbo.users' or 'schema.table'). Reference tables by their direct name only.",

      "--- SQLITE-SPECIFIC ANALYTICS RULES ---",
      "Date/Time Handling: SQLite lacks native date types. You MUST use SQLite date functions like strftime('%Y-%m', date_column), date(), or datetime() for temporal grouping and filtering.",
      "Division & Math: To prevent integer division truncation, explicitly cast the numerator using CAST(column AS REAL) before division.",
      "Text Matching: Use LOWER(column) = LOWER('value') or LIKE for robust case-insensitive string comparisons.",
      "Null Handling: Use IFNULL() or COALESCE() to handle potential null values in aggregations to avoid returning empty or broken charts.",

      "--- COLUMN SELECTION & ALIASING ---",
      "Use ONLY exact table and column names from the provided schema catalog. Do not hallucinate columns.",
      "Every computed column or aggregation MUST have a clean, user-friendly, lowercase alias (e.g., total_revenue, active_users).",
      "Never leave raw expressions like 'SUM(price)' or 'COUNT(id)' as the column name.",
      "Avoid using reserved SQL keywords as aliases. If necessary, wrap them in double quotes.",
    ];
  }
}
