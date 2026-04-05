import { decideVisualizationCapability } from "../../graph/visualization.js";
import { buildDirectAnswer } from "../../llm/answers.js";
import { classifyIntentHeuristically } from "../../llm/intent/classifier.js";
import type { GraphStateValue } from "../../llm/state.js";
import type { AgentRunRequest } from "../../types.js";
import { AgentLayer } from "../AgentLayer.js";
import type { LayerContext } from "../AgentLayer.js";

export class IntentLayer extends AgentLayer {
  readonly name = "classifyIntent";

  shouldSkip(state: GraphStateValue): boolean {
    return state.cacheHit;
  }

  async execute(request: AgentRunRequest, _state: GraphStateValue, ctx: LayerContext): Promise<Partial<GraphStateValue>> {
    const intent = classifyIntentHeuristically(request.message, request.history);

    if (intent.kind === "small_talk") {
      ctx.emit({ type: "agent_step", data: { text: "Responding directly without querying the database...", at: new Date().toISOString() } });
      return {
        intentKind: intent.kind,
        wantsVisualization: intent.wantsVisualization,
        visualizationRequest: null,
        visualizationCapabilityDecision: null,
        answer: buildDirectAnswer(request.message),
        suggestions: [],
        steps: [{ text: "Responding directly without querying the database...", at: new Date().toISOString() }],
      };
    }

    ctx.emit({ type: "agent_step", data: { text: "Classifying intent and visualization requirements...", at: new Date().toISOString() } });

    return {
      intentKind: intent.kind,
      wantsVisualization: intent.wantsVisualization,
      visualizationRequest: intent.visualizationRequest,
      visualizationCapabilityDecision: decideVisualizationCapability(intent.visualizationRequest),
      steps: [{ text: "Classifying intent and visualization requirements...", at: new Date().toISOString() }],
    };
  }
}
