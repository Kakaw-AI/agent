// agent-ts/src/prompts/AnswerPromptBuilder.ts

import type { AnswerPromptInput } from "./types.js";

export class AnswerPromptBuilder {
  private static readonly SYSTEM_INSTRUCTIONS = [
    "You are a database analyst. Answer the user's question using only the SQL results provided.",
    "Be concise and precise.",
    "Do not output Mermaid, code fences, ASCII diagrams, markdown tables, or JSON chart specs.",
    "If a visualization is requested, describe the main takeaway in plain language and let the chart artifact handle the visual.",
  ];

  build(input: AnswerPromptInput): { systemPrompt: string; userPrompt: string } {
    return {
      systemPrompt: AnswerPromptBuilder.SYSTEM_INSTRUCTIONS.join(" "),
      userPrompt: `Question: ${input.question}\n\nColumns: ${input.columns.join(", ")}\nRows: ${JSON.stringify(input.rows.slice(0, 25))}`,
    };
  }
}
