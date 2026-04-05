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
    const columns = table.columns
      .map(
        (column) =>
          `${column.name} (${column.dataType}${column.isPrimaryKey ? ", PK" : ""}${column.isNullable ? "" : ", NOT NULL"})`,
      )
      .join(", ");

    const relationships =
      table.foreignKeys.length > 0
        ? table.foreignKeys
            .map((fk) => `${fk.sourceColumn} -> ${fk.targetTable}.${fk.targetColumn}`)
            .join("; ")
        : "none";

    const tablePrefix = table.schemaName ? `${table.schemaName}.` : "";
    return `${tablePrefix}${table.name}: ${columns}. relationships: ${relationships}`;
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

  protected buildRepairPrompt(
    knowledge: DatabaseKnowledgeRuntime,
    sql: string,
    error: string,
    options: SqlPromptOptions,
  ): string {
    return [
      this.buildInitialPrompt(knowledge, options),
      "The prior SQL failed. Repair it and return JSON with only the replacement SQL.",
      `Previous SQL: ${sql}`,
      `Database error: ${error}`,
    ].join("\n");
  }

  build({ knowledge, options = {}, repair }: SqlPromptBuildInput): string {
    if (repair) {
      return this.buildRepairPrompt(knowledge, repair.sql, repair.error, options);
    }
    return this.buildInitialPrompt(knowledge, options);
  }
}
