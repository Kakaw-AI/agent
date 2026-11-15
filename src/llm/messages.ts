import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { MAX_HISTORY_MESSAGES, MAX_HISTORY_ROWS } from "../config.js";
import type { AgentHistoryMessage } from "../types.js";

/**
 * An earlier assistant turn as the model sees it: the answer, the SQL that
 * produced it, and a few of its rows.
 *
 * The SQL matters most. Without it a follow-up such as "now only express
 * orders" had to be rebuilt from the prose of the earlier answer, and the
 * filters and grouping that were never spelled out in that prose were lost.
 * The rows are only there so "those" has a referent, so a handful is enough.
 */
export function describeAssistantTurn(message: AgentHistoryMessage): string {
  const parts = [message.content];

  if (message.sql) {
    parts.push(`[SQL used]\n${message.sql}`);
  }

  if (message.rows && message.rows.length > 0 && message.columns) {
    const shown = message.rows.slice(0, MAX_HISTORY_ROWS);
    const omitted = message.rows.length - shown.length;
    parts.push(
      `[Query Results]${omitted > 0 ? ` (${omitted} more rows omitted)` : ""}\ncolumns: ${JSON.stringify(message.columns)}\nrows: ${JSON.stringify(shown)}`,
    );
  }

  return parts.join("\n\n");
}

/** Only the most recent turns are replayed; the full transcript grew without bound. */
export function recentHistory(history: AgentHistoryMessage[]): AgentHistoryMessage[] {
  return history.length > MAX_HISTORY_MESSAGES
    ? history.slice(history.length - MAX_HISTORY_MESSAGES)
    : history;
}

export function toLangChainMessages(history: AgentHistoryMessage[]) {
  return recentHistory(history).map((message) => {
    switch (message.role) {
      case "assistant":
        return new AIMessage(describeAssistantTurn(message));
      case "system":
        return new SystemMessage(message.content);
      default:
        return new HumanMessage(message.content);
    }
  });
}
