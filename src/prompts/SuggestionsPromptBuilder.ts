import type { SuggestionsPromptInput } from "./types.js";

/**
 * Follow-up questions grounded in the current result. Built from the rows
 * rather than the written answer, so this runs at the same time as the answer
 * instead of after it.
 */
export class SuggestionsPromptBuilder {
  build(input: SuggestionsPromptInput): { systemPrompt: string; userPrompt: string } {
    return {
      systemPrompt: [
        "You are a database analyst proposing what to explore NEXT.",
        "You are given the question the user JUST asked and the result it returned.",
        "Suggest exactly three short follow-up questions that build directly on THIS result: drill down, break down, compare, rank, or trend the entities and metrics that just appeared.",
        "Each suggestion must:",
        "- be a natural next step from the current result (NOT a restatement of the current question, and NOT about an unrelated earlier topic),",
        "- be answerable using only the available tables, and",
        "- be a single concise question (max ~12 words).",
        `Available tables: ${input.tableNames}`,
        'Return JSON: {"suggestions": [three strings]}.',
      ].join("\n"),
      userPrompt: [
        `Current question: ${input.question}`,
        `Result columns: ${input.columns.join(", ") || "(none)"}`,
        `Rows returned: ${input.rowCount}`,
        `First rows: ${JSON.stringify(input.rows.slice(0, 5))}`,
        `Schema summary: ${input.summary}`,
      ].join("\n"),
    };
  }
}
