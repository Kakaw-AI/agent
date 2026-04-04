import { invokeJson } from "../../llm/invoke.js";
import { SuggestionsPromptBuilder } from "../../prompts/SuggestionsPromptBuilder.js";
import type { GraphStateValue } from "../../graph/state.js";
import type { AgentRunRequest } from "../../types.js";
import { AgentLayer } from "../AgentLayer.js";

export class SuggestionsLayer extends AgentLayer {
  readonly name = "generateSuggestions";

  shouldSkip(state: GraphStateValue): boolean {
    return state.cacheHit || state.intentKind === "small_talk" || !state.answer;
  }

  async execute(request: AgentRunRequest, state: GraphStateValue): Promise<Partial<GraphStateValue>> {
    const prompt = new SuggestionsPromptBuilder().build({
      question: request.message,
      answer: state.answer,
      tableNames: request.knowledge.tables.map((t) => t.name).join(", "),
      summary: request.knowledge.summary,
    });

    try {
      const { value } = await invokeJson<string[]>({
        llm: request.llm,
        ...prompt,
        history: request.history,
        temperature: 0.5,
      });

      return {
        suggestions: value.filter((item) => typeof item === "string").slice(0, 3),
      };
    } catch {
      return { suggestions: [] };
    }
  }
}
