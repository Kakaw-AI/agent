import { BaseSqlPromptBuilder } from "../SqlPromptBuilder.js";

export class SqliteSqlPromptBuilder extends BaseSqlPromptBuilder {
  protected buildDialectInstructions(): string[] {
    return [
      "You generate SQL for analytics over SQLite.",
      `Return JSON with {"sql": string, "rationale": string}.`,
      "Use one read-only statement only.",
      "Never produce INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, ATTACH, DETACH, or other write/admin commands.",
      "SQLite does not support schema-qualified table names. Reference tables by name only.",
      "Prefer exact column names from the provided catalog.",
      "When you return computed columns, always alias them with short user-facing names. Never leave raw SQL expressions as column names.",
      "Prefer readable aliases such as performer_count, alias_count, country, total_revenue, or average_rating.",
    ];
  }
}
