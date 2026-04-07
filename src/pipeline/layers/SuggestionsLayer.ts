import { invokeJson } from "../../llm/invoke.js";
import { SuggestionsSchema } from "../../llm/schemas.js";
import type { GraphStateValue } from "../../llm/state.js";
import { SuggestionsPromptBuilder } from "../../prompts/SuggestionsPromptBuilder.js";
import type { AgentRunRequest } from "../../types.js";
import { AgentLayer } from "../AgentLayer.js";
import type { LayerContext } from "../AgentLayer.js";

export class SuggestionsLayer extends AgentLayer {
  readonly name = "generateSuggestions";

  shouldSkip(state: GraphStateValue): boolean {
    return state.cacheHit || state.intentKind === "small_talk" || !state.answer;
  }

  async execute(request: AgentRunRequest, state: GraphStateValue, ctx: LayerContext): Promise<Partial<GraphStateValue>> {
    ctx.emit({ type: "agent_step", data: { text: "Generating follow-up suggestions...", at: new Date().toISOString() } });

    const prompt = new SuggestionsPromptBuilder().build({
      question: request.message,
      answer: state.answer,
      tableNames: request.knowledge.tables.map((t) => t.name).join(", "),
      summary: request.knowledge.summary,
    });

    try {
      const { value } = await invokeJson({
        llm: request.llm,
        ...prompt,
        history: request.history,
        temperature: 0.5,
        onLlmCall: ctx.onLlmCall,
        onLlmResponse: ctx.onLlmResponse,
        schema: SuggestionsSchema,
      });

      return {
        suggestions: value.filter((item) => typeof item === "string").slice(0, 3),
      };
    } catch {
      return { suggestions: [] };
    }
  }
}
