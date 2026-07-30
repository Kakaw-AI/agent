import { getSchemaIndex } from "../../database/schema-index.js";
import {
  describeFieldResolution,
  resolveVisualizationRequestFields,
} from "../../graph/field-resolution.js";
import { decideVisualizationCapability } from "../../graph/visualization.js";
import { buildDirectAnswer } from "../../llm/answers.js";
import { classifyIntentHeuristically } from "../../llm/intent/classifier.js";
import { extractRowsFromHistory } from "../../llm/intent/history.js";
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

    // The field names above came out of regexes over the raw question, so they
    // are whatever the user typed. Reconcile them with the catalog here, before
    // anything downstream compares them for equality.
    const schemaIndex = getSchemaIndex(
      request.knowledge,
      request.database.schemaFingerprint,
    );
    const resolution = resolveVisualizationRequestFields(
      intent.visualizationRequest,
      schemaIndex,
    );
    const visualizationRequest = resolution?.request ?? intent.visualizationRequest;

    const steps = [{ text: "Classifying intent and visualization requirements...", at: new Date().toISOString() }];
    const resolutionNote = describeFieldResolution(resolution);
    if (resolutionNote) {
      ctx.emit({ type: "agent_step", data: { text: resolutionNote, at: new Date().toISOString() } });
      steps.push({ text: resolutionNote, at: new Date().toISOString() });
    }

    const resolutionState: Partial<GraphStateValue> = resolution
      ? {
          fieldResolutions: resolution.entries,
          schemaCorrections: resolution.corrections.map((correction) => ({
            ...correction,
            stage: "intent",
          })),
          toolCalls: [
            {
              tool: "schema_resolution",
              corrections: resolution.corrections,
              unresolved: resolution.unresolved,
              didYouMean: resolution.didYouMean,
            },
          ],
        }
      : {};

    if (intent.kind === "visualization_followup") {
      const prior = extractRowsFromHistory(request.history);
      return {
        intentKind: intent.kind,
        wantsVisualization: intent.wantsVisualization,
        visualizationRequest,
        visualizationCapabilityDecision: decideVisualizationCapability(visualizationRequest),
        rows: prior?.rows ?? [],
        columns: prior?.columns ?? [],
        steps,
        ...resolutionState,
      };
    }

    return {
      intentKind: intent.kind,
      wantsVisualization: intent.wantsVisualization,
      visualizationRequest,
      visualizationCapabilityDecision: decideVisualizationCapability(visualizationRequest),
      steps,
      ...resolutionState,
    };
  }
}
