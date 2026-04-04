import { invokeJson } from "../../llm/invoke.js";
import { assessVisualizationSqlDraft, buildVisualizationSqlExhaustedOutcome } from "../../graph/qa/assessment.js";
import { buildFailurePresentation } from "../../errors.js";
import { PostgresSqlPromptBuilder } from "../../prompts/database/PostgresSqlPromptBuilder.js";
import { SqliteSqlPromptBuilder } from "../../prompts/database/SqliteSqlPromptBuilder.js";
import type { BaseSqlPromptBuilder } from "../../prompts/SqlPromptBuilder.js";
import { VisualizationSqlUserPromptBuilder } from "../../prompts/VisualizationSqlUserPromptBuilder.js";
import { mergeTokenUsage } from "../../utils/token.js";
import type { GraphStateValue } from "../../graph/state.js";
import type { AgentRunRequest, TokenUsage } from "../../types.js";
import { AgentLayer } from "../AgentLayer.js";

function createSqlPromptBuilder(provider: string): BaseSqlPromptBuilder {
  if (provider === "sqlite") {
    return new SqliteSqlPromptBuilder();
  }
  return new PostgresSqlPromptBuilder();
}

export class SqlGenerationLayer extends AgentLayer {
  readonly name = "generateSql";

  shouldSkip(state: GraphStateValue): boolean {
    return state.cacheHit || state.intentKind === "small_talk" || !!state.answer || !!state.errorMessage;
  }

  async execute(request: AgentRunRequest, state: GraphStateValue): Promise<Partial<GraphStateValue>> {
    const sqlPromptBuilder = createSqlPromptBuilder(request.database.provider);
    const userPromptBuilder = new VisualizationSqlUserPromptBuilder();
    let tokenUsage: TokenUsage | null = null;
    let lastSql = "";
    let lastRationale: string | null = null;
    let priorErrors: string[] = [];
    const MAX_DRAFT_ATTEMPTS = 3;

    for (let attempt = 0; attempt < MAX_DRAFT_ATTEMPTS; attempt += 1) {
      try {
        const result = await invokeJson<{ sql: string; rationale?: string }>({
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
        const failure = buildFailurePresentation(message);
        return {
          errorMessage: message,
          publicErrorMessage: failure.publicMessage,
          steps: [{ text: failure.stepText, at: new Date().toISOString() }],
        };
      }
    }

    return buildVisualizationSqlExhaustedOutcome(priorErrors);
  }
}
