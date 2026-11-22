import type { AgentRunRequest } from "../types.js";

/** Shorter values ("US", "2024", "Yes") are too common to identify anything. */
const MIN_VALUE_LENGTH = 4;

function addValue(values: Set<string>, value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return;
  const text = String(value).trim().toLowerCase();
  if (text.length >= MIN_VALUE_LENGTH) values.add(text);
}

/** Every value the model has seen from the user's database: catalog samples and replayed result rows. */
export function databaseValues(request: AgentRunRequest): Set<string> {
  const values = new Set<string>();
  for (const table of request.knowledge.tables) {
    for (const column of table.columns) for (const value of column.sampleValues ?? []) addValue(values, value);
    for (const row of table.sampleRows ?? []) for (const value of Object.values(row)) addValue(values, value);
  }
  for (const turn of request.history) {
    for (const row of turn.rows ?? []) for (const value of Object.values(row)) addValue(values, value);
  }
  return values;
}

/** Everything the user typed in this conversation: values in it are theirs to search for. */
export function userTypedText(request: AgentRunRequest): string {
  return [...request.history.filter((turn) => turn.role === "user").map((turn) => turn.content), request.message].join("\n");
}

/**
 * True when a search query would send data from the user's database to the
 * search engine: it contains a database value the user did not type themselves
 * (in this message or an earlier one). Such a search is dropped, not edited.
 */
export function leaksDatabaseValues(query: string, userText: string, values: Set<string>): boolean {
  const lowerQuery = query.toLowerCase();
  const lowerMessage = userText.toLowerCase();
  for (const value of values) {
    if (lowerQuery.includes(value) && !lowerMessage.includes(value)) return true;
  }
  return false;
}
