import { z } from "zod";

export const SqlResponseSchema = z.object({
  sql: z.string(),
});

export const SqlWithRationaleSchema = z.object({
  sql: z.string(),
  rationale: z.string(),
});
export const SuggestionsSchema = z.array(z.string());

export const ChartPlanSchema = z.object({
  kind: z.enum(["bar", "line", "pie", "scatter", "histogram"]),
  title: z.string(),
  xField: z.string(),
  yField: z.string(),
});

