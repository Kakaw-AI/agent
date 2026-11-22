import { z } from "zod";

// Every field is required and of a simple type: OpenAI's strict structured
// output rejects optional fields, and small local models follow flat schemas
// more reliably. "Absent" is an empty string or empty list instead.

/** Rewrites a follow-up into a question that stands on its own. */
export const RouteSchema = z.object({
  kind: z.enum(["data", "chart_previous", "small_talk"]),
  standaloneQuestion: z.string(),
});

/** A SQL draft, or a clarifying question when the request cannot be answered as asked. */
export const SqlDraftSchema = z.object({
  needsClarification: z.boolean(),
  clarifyingQuestion: z.string(),
  options: z.array(z.string()),
  sql: z.string(),
  rationale: z.string(),
  /** Outside facts are needed (benchmarks, definitions, current events); searched with webQuery. */
  needsWeb: z.boolean(),
  webQuery: z.string(),
});

/** A second look at an executed result before it is shown. */
export const VerifySchema = z.object({
  answersQuestion: z.boolean(),
  problem: z.string(),
});

// An object, not a bare array: tool-calling providers require an object at
// the root of a structured-output schema, so the array form failed on them
// and the suggestions were silently dropped.
export const SuggestionsSchema = z.object({
  suggestions: z.array(z.string()),
});

/** A short name for the conversation, from its first question. */
export const TitleSchema = z.object({
  title: z.string(),
});

export const ChartPlanSchema = z.object({
  kind: z.enum(["bar", "line", "pie", "scatter", "histogram"]),
  title: z.string(),
  xField: z.string(),
  yField: z.string(),
});
