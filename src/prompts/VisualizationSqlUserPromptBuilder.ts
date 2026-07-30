// agent-ts/src/prompts/VisualizationSqlUserPromptBuilder.ts

import { getRequiredVisualizationFields } from "../graph/visualization.js";
import type { VisualizationSqlUserPromptInput } from "../graph/types.js";

export class VisualizationSqlUserPromptBuilder {
  build(input: VisualizationSqlUserPromptInput): string {
    const lines = [`Question: ${input.question}`];

    if (input.visualizationRequest) {
      const requiredFields = getRequiredVisualizationFields(input.visualizationRequest);
      lines.push(
        `Normalized visualization request: ${JSON.stringify(input.visualizationRequest)}`,
        `Preserve every requested visualization field in the SQL result: ${requiredFields.join(", ")}.`,
        "Use readable aliases for aggregate metrics and computed columns.",
        "Do not drop requested dimensions. Regenerate the SQL instead of returning a narrower query.",
      );
    }

    if (input.needsImplicitCountMetric) {
      lines.push(
        "The chart should use COUNT(*) grouped by the requested category unless the user explicitly asked for a different metric.",
      );
    }

    if (input.priorSql) {
      lines.push(`Previous SQL draft that must be corrected:\n${input.priorSql}`);
    }

    if (input.priorErrors && input.priorErrors.length > 0) {
      lines.push(`Previous draft issues: ${input.priorErrors.join(" ")}`);
    }

    // The volatile half of a repair lives here rather than in the system
    // prompt, so the schema catalog above it stays byte-identical between the
    // first attempt and every retry and can be served from the prompt cache.
    if (input.dbErrorBlock) {
      lines.push(input.dbErrorBlock);
    }

    if (input.fieldSuggestions && input.fieldSuggestions.length > 0) {
      for (const suggestion of input.fieldSuggestions) {
        if (suggestion.candidates.length > 0) {
          lines.push(
            `No catalog column matches "${suggestion.field}". Closest candidates: ${suggestion.candidates.join(", ")}.`,
          );
        }
      }
    }

    return lines.join("\n");
  }
}
