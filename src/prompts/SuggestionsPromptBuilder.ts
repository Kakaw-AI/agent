// agent-ts/src/prompts/SuggestionsPromptBuilder.ts

import type { SuggestionsPromptInput } from "./types.js";

export class SuggestionsPromptBuilder {
  build(input: SuggestionsPromptInput): { systemPrompt: string; userPrompt: string } {
    return {
      systemPrompt: [
        "You are a database analyst proposing what to explore NEXT.",
        "You are given the question the user JUST asked, the answer they just received, and the shape of the result (its columns).",
        "Suggest exactly three short follow-up questions that build directly on THIS result — drill down, break down, compare, rank, or trend the entities/metrics that just appeared.",
        "Each suggestion must:",
        "- be a natural next step from the current result (NOT a restatement of the current question, and NOT about an unrelated earlier topic),",
        "- be answerable using only the available tables, and",
        "- be a single concise question (max ~12 words).",
        `Available tables: ${input.tableNames}`,
        "Return a JSON array of exactly 3 strings.",
      ].join("\n"),
      userPrompt: [
        `Current question: ${input.question}`,
        `Current answer: ${input.answer}`,
        `Result columns: ${input.columns.join(", ") || "(none)"}`,
        `Rows returned: ${input.rowCount}`,
        `Schema summary: ${input.summary}`,
      ].join("\n"),
    };
  }
}
