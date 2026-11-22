import { webSearchConfigured } from "../net/web-search.js";
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

/**
 * The search a model step asked for, or "" for none. A query carrying values
 * from the user's database is dropped: the search engine is a third party.
 * Fields are checked loosely because small models sometimes omit them.
 *
 * `question` is the standalone form of the user's question. When the user
 * refers to something from an earlier answer ("her latest video"), that form
 * names it ("Yiny's latest video"), and searching for it is what they asked.
 */
export function planWebQuery(needsWeb: unknown, raw: unknown, request: AgentRunRequest, question = ""): string {
  const query = typeof raw === "string" ? raw.trim().slice(0, 200) : "";
  if (needsWeb !== true || !query || !webSearchConfigured()) return "";
  const allowed = `${userTypedText(request)}\n${question}`;
  return leaksDatabaseValues(query, allowed, databaseValues(request)) ? "" : query;
}

/** The prompt rules for writing a search query, shared by the draft and the review. */
export const WEB_QUERY_RULES =
  "webQuery may use names and terms the user typed or clearly referred to (e.g. 'her latest video' right after an answer naming one person means that person). It must NEVER add a value the user did not ask about: no other names, IDs, amounts or emails taken from this database or from earlier results. E.g. if the user asked about 'Acme Corp', 'Acme Corp latest news' is fine; never search for a customer the user did not name or point to.";
