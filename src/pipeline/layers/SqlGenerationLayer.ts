import { assessVisualizationSqlDraft, buildVisualizationSqlExhaustedOutcome } from "../../graph/qa/assessment.js";
import { invokeJson } from "../../llm/invoke.js";
import { SqlWithRationaleSchema } from "../../llm/schemas.js";
import type { GraphStateValue } from "../../llm/state.js";
import { VisualizationSqlUserPromptBuilder } from "../../prompts/VisualizationSqlUserPromptBuilder.js";
import type { AgentRunRequest, TokenUsage } from "../../types.js";
import { mergeTokenUsage } from "../../utils/token.js";
import { AgentLayer } from "../AgentLayer.js";
import type { LayerContext } from "../AgentLayer.js";
import { createSqlPromptBuilder } from "./shared.js";

export class SqlGenerationLayer extends AgentLayer {
  readonly name = "generateSql";

  shouldSkip(state: GraphStateValue): boolean {
    return (
      state.cacheHit ||
      state.intentKind === "small_talk" ||
      state.intentKind === "visualization_followup" ||
      !!state.answer ||
      !!state.errorMessage
    );
  }

  async execute(request: AgentRunRequest, state: GraphStateValue, ctx: LayerContext): Promise<Partial<GraphStateValue>> {
    const sqlPromptBuilder = createSqlPromptBuilder(request.database.provider);
    const userPromptBuilder = new VisualizationSqlUserPromptBuilder();
    let tokenUsage: TokenUsage | null = null;
    let lastSql = "";
    let lastRationale: string | null = null;
    let priorErrors: string[] = [];
    const MAX_DRAFT_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_DRAFT_ATTEMPTS; attempt += 1) {
      const attemptLabel = attempt === 0
        ? "Generating read-only SQL..."
        : `Retrying SQL generation (attempt ${attempt + 1}/${MAX_DRAFT_ATTEMPTS})...`;

      ctx.emit({ type: "agent_step", data: { text: attemptLabel, at: new Date().toISOString() } });

      try {
        const result = await invokeJson({
          llm: request.llm,
          systemPrompt: sqlPromptBuilder.build({
            knowledge: request.knowledge,
            options: {
              wantsVisualization: state.wantsVisualization,
              needsImplicitCountMetric: state.needsImplicitCountMetric,
              visualizationRequest: state.visualizationRequest,
            },
          }),
          userPrompt: userPromptBuilder.build({
            question: request.message,
            visualizationRequest: state.visualizationRequest,
            needsImplicitCountMetric: state.needsImplicitCountMetric,
            priorSql: attempt > 0 ? lastSql : null,
            priorErrors,
          }),
          history: request.history,
          temperature: 0.1,
          onLlmCall: ctx.onLlmCall,
          onLlmResponse: ctx.onLlmResponse,
          schema: SqlWithRationaleSchema,
        });

        tokenUsage = mergeTokenUsage(tokenUsage, result.tokenUsage);
        lastSql = result.value.sql.trim();
        lastRationale = result.value.rationale ?? null;

        const assessment = assessVisualizationSqlDraft({
          sql: lastSql,
          visualizationRequest: state.wantsVisualization ? state.visualizationRequest : null,
        });

        if (assessment.ok) {
          return {
            sql: lastSql,
            tokenUsage,
            visualizationValidationStatus:
              state.wantsVisualization && state.visualizationRequest
                ? "pending"
                : state.visualizationValidationStatus,
            steps: [{ text: "Generating read-only SQL...", at: new Date().toISOString() }],
            toolCalls: [{ tool: "sql_generation", sql: lastSql, rationale: lastRationale }],
          };
        }

        priorErrors = assessment.errors;
      } catch (err) {
        const message = err instanceof Error ? err.message : "SQL generation failed.";
        return {
          errorMessage: message,
          steps: [{ text: `Failed: ${message}`, at: new Date().toISOString() }],
        };
      }
    }

    return buildVisualizationSqlExhaustedOutcome(priorErrors);
  }
}
