import { BaseSqlPromptBuilder } from "../SqlPromptBuilder.js";

export class PostgresSqlPromptBuilder extends BaseSqlPromptBuilder {
  protected buildDialectInstructions(): string[] {
    return [
      "You generate SQL for analytics over PostgreSQL.",
      `Return JSON with {"sql": string, "rationale": string}.`,
      "Use one read-only statement only.",
      "Never produce INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, or other write/admin commands.",
      "Use schema-qualified table names when the catalog provides a schema name (e.g. public.orders).",
      "Prefer exact schema names and columns from the provided catalog.",
      "When you return computed columns, always alias them with short user-facing names. Never leave raw SQL expressions as column names.",
      "Prefer readable aliases such as performer_count, alias_count, country, total_revenue, or average_rating.",
    ];
  }
}
