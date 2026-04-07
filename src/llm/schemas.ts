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

export type SqlResponse = z.infer<typeof SqlResponseSchema>;
export type SqlWithRationale = z.infer<typeof SqlWithRationaleSchema>;
export type Suggestions = z.infer<typeof SuggestionsSchema>;
export type ChartPlan = z.infer<typeof ChartPlanSchema>;
