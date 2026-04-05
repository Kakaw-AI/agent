import { StateGraph } from "@langchain/langgraph";
import type { GraphStateValue } from "../llm/state.js";
import { GraphState } from "../llm/state.js";
import type { AgentRunRequest, AgentStreamEvent, TraceAnalyticsOutcome, VisualizationOutcome } from "../types.js";
import type { AgentLayer, EdgeDef, LayerContext, LayerMap } from "./AgentLayer.js";
import { EdgeBuilder } from "./AgentLayer.js";
import { PipelineEmitter } from "./PipelineEmitter.js";
import { PipelineLogger } from "./PipelineLogger.js";

export class AgentPipeline {
  private layers: AgentLayer[] = [];

  use(layer: AgentLayer): this {
    this.layers.push(layer);
    return this;
  }

  /** Exposed for testing — builds the node handler with skip wrapping and context injection. */
  protected buildNodeHandler(
    layer: AgentLayer,
    request: AgentRunRequest,
    emitter: PipelineEmitter,
    logger: PipelineLogger,
  ): (state: GraphStateValue) => Promise<Partial<GraphStateValue>> {
    return async (state: GraphStateValue) => {
      if (layer.shouldSkip && layer.shouldSkip(state)) {
        logger.logLayerSkipped(layer.name);
        return {};
      }

      const startMs = Date.now();
      logger.logLayerStarted(layer.name);

      const ctx: LayerContext = {
        emit: (event) => emitter.emit(event),
        onLlmCall: logger.onLlmCall(layer.name),
        onLlmResponse: logger.onLlmResponse(layer.name),
      };

      try {
        const result = await layer.execute(request, state, ctx);
        logger.logLayerCompleted(layer.name, result, Date.now() - startMs);
        return result;
      } catch (error) {
        logger.logLayerError(layer.name, error, Date.now() - startMs);
        throw error;
      }
    };
  }

  async *stream(request: AgentRunRequest): AsyncGenerator<AgentStreamEvent> {
    const emitter = new PipelineEmitter();
    const logger = new PipelineLogger(request);

    // message_started goes out immediately before any layer runs
    emitter.emit({ type: "message_started", data: { messageId: request.messageId } });

    // start the graph as a floating promise — do NOT await here
    const graphPromise = this.runGraph(request, emitter, logger);

    // yield events as they arrive from layers
    for await (const event of emitter) {
      yield event;
    }

    // surface any error thrown inside runGraph
    await graphPromise;
  }

  /** Backward-compat wrapper used by tests that expect an array. */
  async run(request: AgentRunRequest): Promise<AgentStreamEvent[]> {
    const events: AgentStreamEvent[] = [];
    for await (const event of this.stream(request)) {
      events.push(event);
    }
    return events;
  }

  private async runGraph(
    request: AgentRunRequest,
    emitter: PipelineEmitter,
    logger: PipelineLogger,
  ): Promise<void> {
    logger.logRunStart();
    const runStartMs = Date.now();

    try {
      const layerMap: LayerMap = new Map(this.layers.map((l) => [l.name, l]));
      const graphBuilder = new StateGraph(GraphState);

      for (const layer of this.layers) {
        graphBuilder.addNode(layer.name, this.buildNodeHandler(layer, request, emitter, logger));
      }

      if (this.layers.length > 0) {
        graphBuilder.addEdge("__start__", this.layers[0].name as any);
      }

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

      // emit terminal events — agent_step already went live during execution
      for (const event of buildTerminalEvents(request, finalState as GraphStateValue)) {
        emitter.emit(event);
      }

      logger.logRunEnd(finalState as GraphStateValue, Date.now() - runStartMs);
    } catch (error) {
      const message = error instanceof Error ? error.message.trim() || "Unexpected agent failure." : "Unexpected agent failure.";
      logger.logRunError(message, Date.now() - runStartMs);
      emitter.emit({
        type: "message_failed",
        data: {
          messageId: request.messageId,
          error: message,
          errorInfo: {
            message,
            code: "AGENT_RUNTIME_ERROR",
            statusCode: 500,
            retryable: false,
          },
        },
      });
    } finally {
      emitter.finish();
    }
  }
}

// ---------------------------------------------------------------------------
// Terminal event builder — emits everything except message_started and
// agent_step (those are emitted live by layers via ctx.emit).
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
  if (finalState.errorMessage || !finalState.answer) return "failed";
  if (visualizationOutcome?.validation?.status === "narrowed") return "narrowed";
  if (finalState.chartSpec) return "chart_rendered";
  if (finalState.sql && finalState.rowCount === 0) return "no_rows";
  return "completed_text";
}

function buildTerminalEvents(
  request: AgentRunRequest,
  finalState: GraphStateValue,
): AgentStreamEvent[] {
  const visualizationOutcome = buildVisualizationOutcome(finalState);
  const analyticsOutcome = buildTraceAnalyticsOutcome(finalState, visualizationOutcome);

  const events: AgentStreamEvent[] = [];

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
    events.push(traceEvent);
    events.push({
      type: "message_failed",
      data: {
        messageId: request.messageId,
        error: finalState.errorMessage,
        errorInfo: {
          message: finalState.errorMessage,
          code: "AGENT_SQL_GENERATION_FAILED",
          statusCode: 502,
          retryable: false,
          metadata: { raw: finalState.errorMessage },
        },
      },
    });
    return events;
  }

  if (!finalState.answer) {
    events.push(traceEvent);
    events.push({
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
    });
    return events;
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
