import { buildNoRowsAnswer } from "../../llm/answers.js";
import { invokeText } from "../../llm/invoke.js";
import type { GraphStateValue } from "../../llm/state.js";
import { AnswerPromptBuilder } from "../../prompts/AnswerPromptBuilder.js";
import type { AgentRunRequest } from "../../types.js";
import { AgentLayer } from "../AgentLayer.js";

export class AnswerLayer extends AgentLayer {
  readonly name = "composeAnswer";

  shouldSkip(state: GraphStateValue): boolean {
    return state.cacheHit || state.intentKind === "small_talk" || !!state.errorMessage;
  }

  async execute(request: AgentRunRequest, state: GraphStateValue): Promise<Partial<GraphStateValue>> {
    if (typeof state.answer === "string" && state.answer.trim()) {
      return {};
    }

    if (state.rows.length === 0) {
      return {
        answer: buildNoRowsAnswer({ question: request.message, sql: state.sql }),
        steps: [{ text: "The query completed, but no matching rows were found.", at: new Date().toISOString() }],
      };
    }

    const prompt = new AnswerPromptBuilder().build({
      question: request.message,
      columns: state.columns,
      rows: state.rows,
    });

    const { content, tokenUsage } = await invokeText({
      llm: request.llm,
      ...prompt,
      history: request.history,
      temperature: 0.2,
    });

    return {
      answer: content,
      tokenUsage,
      steps: [{ text: "Writing the response from query results...", at: new Date().toISOString() }],
    };
  }
}
