import { buildFallbackChartSpec, planChartSpecDeterministically } from "../../graph/chart-spec.js";
import type { ChartPlanLlmResponse } from "../../graph/types.js";
import { shouldAutoPlanChart } from "../../llm/intent/chart-planning.js";
import { invokeJson } from "../../llm/invoke.js";
import { ChartPlanPromptBuilder } from "../../prompts/ChartPlanPromptBuilder.js";
import { toReadableLabel } from "../../utils/text.js";
import type { GraphStateValue } from "../../graph/state.js";
import type { AgentRunRequest } from "../../types.js";
import { AgentLayer } from "../AgentLayer.js";

export class ChartLayer extends AgentLayer {
  readonly name = "planChart";

  shouldSkip(state: GraphStateValue): boolean {
    return (
      state.cacheHit ||
      state.rows.length === 0 ||
      state.visualizationValidationStatus === "invalid" ||
      state.visualizationValidationStatus === "narrowed"
    );
  }

  async execute(request: AgentRunRequest, state: GraphStateValue): Promise<Partial<GraphStateValue>> {
    const autoChartAllowed =
      state.intentKind === "explicit_visualization" ||
      state.intentKind === "visualization_followup" ||
      shouldAutoPlanChart({ question: request.message, columns: state.columns, rows: state.rows });

    if (!autoChartAllowed) {
      return {};
    }

    const numericColumns = state.columns.filter((column) =>
      state.rows.some((row) => typeof row[column] === "number"),
    );
    const labelColumns = state.columns.filter((column) =>
      state.rows.some((row) => typeof row[column] === "string"),
    );

    if (numericColumns.length === 0) {
      return {};
    }

    const deterministicChartSpec = planChartSpecDeterministically({
      question: request.message,
      columns: state.columns,
      rows: state.rows,
      visualizationRequest: state.visualizationRequest,
    });

    if (deterministicChartSpec) {
      return {
        chartSpec: deterministicChartSpec,
        steps: [{ text: "Planning a D3 visualization...", at: new Date().toISOString() }],
        toolCalls: [{
          tool: "chart_planning",
          kind: deterministicChartSpec.kind,
          xField: deterministicChartSpec.xField,
          yField: deterministicChartSpec.yField,
          seriesField: deterministicChartSpec.seriesField ?? null,
          stacked: deterministicChartSpec.stacked ?? false,
          planner: "deterministic",
        }],
      };
    }

    const prompt = new ChartPlanPromptBuilder().build({
      question: request.message,
      columns: state.columns,
      numericColumns,
      labelColumns,
      rows: state.rows,
    });

    try {
      const { value } = await invokeJson<ChartPlanLlmResponse>({
        llm: request.llm,
        ...prompt,
        temperature: 0.1,
      });

      const xValid = state.columns.includes(value.xField);
      const yValid = value.kind === "histogram" || state.columns.includes(value.yField);

      if (!xValid || !yValid) {
        return {
          chartSpec: buildFallbackChartSpec({ question: request.message, columns: state.columns, rows: state.rows }),
          steps: [{ text: "Planning a D3 visualization...", at: new Date().toISOString() }],
        };
      }

      return {
        chartSpec: {
          kind: value.kind,
          title: value.title,
          xField: value.xField,
          yField: value.kind === "histogram" ? value.xField : value.yField,
          xLabel: toReadableLabel(value.xField),
          yLabel: toReadableLabel(value.kind === "histogram" ? value.xField : value.yField),
          data: state.rows.slice(0, 20),
        },
        steps: [{ text: "Planning a D3 visualization...", at: new Date().toISOString() }],
        toolCalls: [{ tool: "chart_planning", kind: value.kind, xField: value.xField, yField: value.yField, planner: "llm_fallback" }],
      };
    } catch {
      return {
        chartSpec: buildFallbackChartSpec({ question: request.message, columns: state.columns, rows: state.rows }),
        steps: [{ text: "Planning a D3 visualization...", at: new Date().toISOString() }],
      };
    }
  }
}
