import { renderCatalogLine } from "../database/catalog-render.js";
import type { DatabaseCatalogTable, DatabaseKnowledgeRuntime } from "../types.js";
import { getRequiredVisualizationFields } from "../graph/visualization.js";
import type { SqlPromptBuildInput, SqlPromptOptions } from "../graph/types.js";

export abstract class BaseSqlPromptBuilder {
  protected abstract buildDialectInstructions(): string[];

  protected buildVisualizationModeInstruction(options: SqlPromptOptions): string {
    if (options.wantsVisualization) {
      return "The user explicitly wants a visualization. Prefer a result set that is easy to chart, with one category/time column and one numeric metric when possible.";
    }
    return "Only prepare chart-friendly result sets when the question clearly calls for it.";
  }

  protected buildVisualizationFieldsInstruction(options: SqlPromptOptions): string {
    if (!options.visualizationRequest) {
      return "No normalized visualization request was provided.";
    }
    const fields = getRequiredVisualizationFields(options.visualizationRequest).join(", ");
    return `The normalized visualization request requires these result fields to be preserved exactly: ${fields}.`;
  }

  protected buildVisualizationDimensionInstruction(options: SqlPromptOptions): string {
    if (!options.visualizationRequest) {
      return "When no visualization request is provided, keep the result set aligned to the analytical question.";
    }
    return "Do not drop requested visualization dimensions. If the request cannot be satisfied exactly, say so in the rationale and keep all requested fields in the SQL draft.";
  }

  protected buildMetricInstruction(options: SqlPromptOptions): string {
    if (options.needsImplicitCountMetric) {
      return "If the user asks to visualize a category without naming a metric, group by that category and use COUNT(*) as the metric.";
    }
    return "Do not invent unsupported metrics.";
  }

  protected buildSchemaLine(table: DatabaseCatalogTable): string {
    // Shared with the sync-time size estimate so the two cannot drift.
    return renderCatalogLine(table);
  }

  protected buildInitialPrompt(
    knowledge: DatabaseKnowledgeRuntime,
    options: SqlPromptOptions,
  ): string {
    const schemaLines = knowledge.tables.map((table) => this.buildSchemaLine(table));

    return [
      ...this.buildDialectInstructions(),
      this.buildVisualizationModeInstruction(options),
      this.buildVisualizationFieldsInstruction(options),
      this.buildVisualizationDimensionInstruction(options),
      this.buildMetricInstruction(options),
      "Every aggregate metric must have a readable user-facing alias such as model_count, total_revenue, or average_rating.",
      `Knowledge summary: ${knowledge.summary || "No summary available."}`,
      "Catalog:",
      ...schemaLines,
    ].join("\n");
  }

  /**
   * Repair variant of the system prompt.
   *
   * Deliberately free of the failing SQL and the error text. Anthropic prompt
   * caching marks the whole system string as one cacheable block, so appending
   * per-attempt detail here changed the block on every retry and re-charged the
   * full schema catalog each time. The volatile detail now travels in the user
   * message; this differs from the initial prompt only by one fixed sentence.
   */
  protected buildRepairPrompt(
    knowledge: DatabaseKnowledgeRuntime,
    options: SqlPromptOptions,
  ): string {
    return [
      this.buildInitialPrompt(knowledge, options),
      "The prior SQL failed. Repair it and return JSON with only the replacement SQL. The failing SQL and the database error appear in the user message.",
    ].join("\n");
  }

  build({ knowledge, options = {}, repair }: SqlPromptBuildInput): string {
    if (repair) {
      return this.buildRepairPrompt(knowledge, options);
    }
    return this.buildInitialPrompt(knowledge, options);
  }
}
