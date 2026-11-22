import { invokeStructured } from "../llm/invoke.js";
import { TitleSchema } from "../llm/schemas.js";
import type { AgentRunRequest } from "../types.js";
import type { RunLogger } from "./logger.js";

const MAX_LENGTH = 60;

/** Trims quotes, a trailing full stop and runaway length off a model's title. */
export function cleanTitle(raw: string): string {
  const title = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'`“”«»]+|["'`“”«»]+$/g, "")
    .replace(/[.。]+$/, "")
    .trim();
  if (title.length <= MAX_LENGTH) return title;
  const cut = title.slice(0, MAX_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Names the conversation from its first question. Runs beside the main graph,
 * so it adds no wait; any failure just leaves the placeholder title.
 */
export async function generateTitle(
  request: AgentRunRequest,
  logger: RunLogger,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const { value } = await invokeStructured({
      llm: request.llm,
      systemPrompt: [
        "You name chat conversations about a database.",
        "Write a title of 2 to 6 words that says what the user is asking about.",
        "Use the same language as the question. No quotes, no trailing punctuation, no emoji.",
        'Return JSON: {"title": string}.',
      ].join("\n"),
      userPrompt: `Question: ${request.message}`,
      name: "conversation_title",
      light: true,
      temperature: 0.3,
      signal,
      onLlmCall: logger.onLlmCall("title"),
      onLlmResponse: logger.onLlmResponse("title"),
      schema: TitleSchema,
    });
    const title = cleanTitle(value.title);
    return title || null;
  } catch {
    return null;
  }
}
