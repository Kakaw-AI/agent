import { PostgresSqlPromptBuilder } from "../../prompts/database/PostgresSqlPromptBuilder.js";
import { SqliteSqlPromptBuilder } from "../../prompts/database/SqliteSqlPromptBuilder.js";
import type { BaseSqlPromptBuilder } from "../../prompts/SqlPromptBuilder.js";

export function createSqlPromptBuilder(provider: string): BaseSqlPromptBuilder {
  if (provider === "sqlite") {
    return new SqliteSqlPromptBuilder();
  }
  return new PostgresSqlPromptBuilder();
}
