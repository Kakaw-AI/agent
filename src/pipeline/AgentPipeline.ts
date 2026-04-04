import { StateGraph } from "@langchain/langgraph";
import type { GraphStateValue } from "../graph/state.js";
import { GraphState } from "../graph/state.js";
import type { AgentRunRequest, AgentStreamEvent, VisualizationOutcome, TraceAnalyticsOutcome } from "../types.js";
import type { AgentLayer, EdgeDef, LayerMap } from "./AgentLayer.js";
import { EdgeBuilder } from "./AgentLayer.js";

export class AgentPipeline {
  private layers: AgentLayer[] = [];

  use(layer: AgentLayer): this {
    this.layers.push(layer);
    return this;
  }

  /** Exposed for testing — builds the node handler with skip wrapping. */
  protected buildNodeHandler(
    layer: AgentLayer,
    request?: AgentRunRequest,
  ): (state: GraphStateValue) => Promise<Partial<GraphStateValue>> {
    return async (state: GraphStateValue) => {
      if (layer.shouldSkip && layer.shouldSkip(state)) {
        return {};
      }
      return layer.execute(request as AgentRunRequest, state);
    };
  }

  async run(request: AgentRunRequest): Promise<AgentStreamEvent[]> {
    const layerMap: LayerMap = new Map(this.layers.map((l) => [l.name, l]));
    const graphBuilder = new StateGraph(GraphState);

    // Register nodes
    for (const layer of this.layers) {
      graphBuilder.addNode(layer.name, this.buildNodeHandler(layer, request));
    }

    // Wire __start__ → first layer
    if (this.layers.length > 0) {
      graphBuilder.addEdge("__start__", this.layers[0].name as any);
    }

    // Wire edges
    for (let i = 0; i < this.layers.length; i++) {
      const layer = this.layers[i];
      const next = this.layers[i + 1];

      if (layer.edges) {
        const builder = new EdgeBuilder();
        layer.edges(builder, layerMap);
        const edgeDefs: EdgeDef[] = builder.getEdges();

        if (edgeDefs.length === 0 && next) {
          graphBuilder.addEdge(layer.name as any, next.name as any);
        } else {
          for (const edge of edgeDefs) {
            if (edge.kind === "unconditional") {
              graphBuilder.addEdge(layer.name as any, edge.target.name as any);
            } else {
              graphBuilder.addConditionalEdges(
                layer.name as any,
                (state: GraphStateValue) => (edge.condition(state) ? edge.target.name : "__end__"),
              );
            }
          }
        }
      } else if (next) {
        graphBuilder.addEdge(layer.name as any, next.name as any);
      } else {
        graphBuilder.addEdge(layer.name as any, "__end__" as any);
      }
    }

    const graph = graphBuilder.compile();
    const finalState = await graph.invoke({});
    return buildEventsFromFinalState(request, finalState);
  }
}

// ---------------------------------------------------------------------------
// Event mapping (moved from llm/runner.ts)
// ---------------------------------------------------------------------------

function buildVisualizationOutcome(finalState: GraphStateValue): VisualizationOutcome | null {
  if (
    !finalState.visualizationRequest &&
    !finalState.visualizationCapabilityDecision &&
    finalState.visualizationValidationStatus === "pending" &&
    !finalState.narrowedVisualizationReason
  ) {
    return null;
  }

  return {
    request: finalState.visualizationRequest ?? {
      categoryFields: [],
      metricField: null,
      seriesField: null,
      groupField: null,
      networkViewRequested: false,
    },
    capabilityDecision: finalState.visualizationCapabilityDecision ?? null,
    validation:
      finalState.visualizationValidationStatus === "pending"
        ? null
        : {
            status: finalState.visualizationValidationStatus,
            errors: finalState.visualizationValidationErrors,
            narrowedFrom: finalState.visualizationValidationNarrowedFrom,
            droppedFields: finalState.visualizationValidationDroppedFields,
          },
    narrowingReason: finalState.narrowedVisualizationReason,
  };
}

function buildTraceAnalyticsOutcome(
  finalState: GraphStateValue,
  visualizationOutcome: VisualizationOutcome | null,
): TraceAnalyticsOutcome {
  if (finalState.errorMessage || !finalState.answer) {
    return "failed";
  }
  if (visualizationOutcome?.validation?.status === "narrowed") {
    return "narrowed";
  }
  if (finalState.chartSpec) {
    return "chart_rendered";
  }
  if (finalState.sql && finalState.rowCount === 0) {
    return "no_rows";
  }
  return "completed_text";
}

export function buildEventsFromFinalState(
  request: AgentRunRequest,
  finalState: GraphStateValue,
): AgentStreamEvent[] {
  const visualizationOutcome = buildVisualizationOutcome(finalState);
  const analyticsOutcome = buildTraceAnalyticsOutcome(finalState, visualizationOutcome);

  const events: AgentStreamEvent[] = [
    { type: "message_started", data: { messageId: request.messageId } },
    ...finalState.steps.map(
      (step) => ({ type: "agent_step", data: { text: step.text } }) as const,
    ),
  ];

  const traceEvent: AgentStreamEvent = {
    type: "agent_trace",
    data: {
      steps: finalState.steps,
      toolCalls: finalState.toolCalls,
      repairHistory: finalState.repairHistory,
      cacheKey: finalState.cacheKey,
      cacheHit: finalState.cacheHit,
      chartSpec: finalState.chartSpec ?? undefined,
      visualizationOutcome,
      analyticsOutcome,
      rowCount: finalState.rowCount,
    },
  };

  if (finalState.sql) {
    events.push({ type: "sql_generated", data: { sql: finalState.sql } });
  }
  if (finalState.rows.length > 0 || finalState.columns.length > 0) {
    events.push({
      type: "sql_result",
      data: {
        rowCount: finalState.rowCount,
        columns: finalState.columns,
        rows: finalState.rows,
      },
    });
  }
  if (finalState.chartSpec && visualizationOutcome?.validation?.status !== "narrowed") {
    events.push({
      type: "chart_generated",
      data: {
        chartType: String(finalState.chartSpec.kind ?? "chart"),
        title:
          typeof finalState.chartSpec.title === "string"
            ? finalState.chartSpec.title
            : undefined,
        spec: finalState.chartSpec,
        visualizationOutcome,
      },
    });
  }

  if (finalState.errorMessage) {
    const publicMessage = finalState.publicErrorMessage ?? finalState.errorMessage;
    return [
      ...events,
      traceEvent,
      {
        type: "message_failed",
        data: {
          messageId: request.messageId,
          error: publicMessage,
          errorInfo: {
            message: publicMessage,
            code: "AGENT_SQL_GENERATION_FAILED",
            statusCode: 502,
            retryable: false,
            metadata: { raw: finalState.errorMessage },
          },
        },
      },
    ];
  }

  if (!finalState.answer) {
    return [
      ...events,
      traceEvent,
      {
        type: "message_failed",
        data: {
          messageId: request.messageId,
          error: "Agent runtime did not produce an answer.",
          errorInfo: {
            message: "Agent runtime did not produce an answer.",
            code: "AGENT_RUNTIME_ERROR",
            statusCode: 500,
            retryable: false,
          },
        },
      },
    ];
  }

  events.push({
    type: "message_completed",
    data: {
      messageId: request.messageId,
      content: finalState.answer,
      tokenUsage: finalState.tokenUsage ?? undefined,
      visualizationOutcome,
      analyticsOutcome,
    },
  });

  if (finalState.suggestions.length > 0) {
    events.push({
      type: "suggestions_generated",
      data: {
        messageId: request.messageId,
        suggestions: finalState.suggestions,
      },
    });
  }

  events.push(traceEvent);
  return events;
}
