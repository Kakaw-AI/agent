// agent-ts/src/prompts/ChartPlanPromptBuilder.ts

import type { ChartPlanPromptInput } from "./types.js";

export class ChartPlanPromptBuilder {
  private static readonly CHART_TYPE_GUIDELINES = [
    "- bar: categorical x-axis, numeric y-axis (comparisons, rankings)",
    "- line: ordered/time x-axis, numeric y-axis (trends over time or sequence)",
    "- pie: one categorical + one numeric column, 8 or fewer categories (part-of-whole)",
    "- scatter: two numeric columns (correlation, distribution of two variables)",
    "- histogram: one numeric column, show distribution (use xField only; set yField same as xField)",
  ];

  build(input: ChartPlanPromptInput): { systemPrompt: string; userPrompt: string } {
    return {
      systemPrompt: [
        "You plan D3 visualizations. Pick the best chart type from: bar, line, pie, scatter, histogram.",
        "Guidelines:",
        ...ChartPlanPromptBuilder.CHART_TYPE_GUIDELINES,
        "Use only field names that exist in the result set.",
        `Available columns: ${input.columns.join(", ")}`,
        `Numeric columns: ${input.numericColumns.join(", ")}`,
        `Label columns: ${input.labelColumns.join(", ")}`,
      ].join("\n"),
      userPrompt: `Question: ${input.question}\nRows sample: ${JSON.stringify(input.rows.slice(0, 10))}`,
    };
  }
}
