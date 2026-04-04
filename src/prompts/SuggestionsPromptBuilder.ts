// agent-ts/src/prompts/SuggestionsPromptBuilder.ts

import type { SuggestionsPromptInput } from "./types.js";

export class SuggestionsPromptBuilder {
  build(input: SuggestionsPromptInput): { systemPrompt: string; userPrompt: string } {
    return {
      systemPrompt: [
        "You are a database analyst. Given the user's question, the answer, and the database schema,",
        "suggest three short follow-up questions that CAN be answered using the available tables.",
        `Available tables: ${input.tableNames}`,
        "Return a JSON array of exactly 3 strings. Each suggestion must reference only the available tables.",
      ].join("\n"),
      userPrompt: `Question: ${input.question}\nAnswer: ${input.answer}\nKnowledge summary: ${input.summary}`,
    };
  }
}
