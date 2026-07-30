import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { MAX_HISTORY_MESSAGES, MAX_HISTORY_ROWS } from "../config.js";
import type { AgentHistoryMessage } from "../types.js";

function withTableData(message: AgentHistoryMessage): string {
  if (message.role !== "assistant" || !message.rows || message.rows.length === 0 || !message.columns) {
    return message.content;
  }
  // Replayed rows exist so a follow-up question has context for what "those"
  // refers to, not so the model can re-analyze the data. A handful is enough;
  // this used to carry up to 50 rows of JSON per prior assistant turn, on every
  // call, for the whole conversation.
  const truncated = message.rows.slice(0, MAX_HISTORY_ROWS);
  const omitted = message.rows.length - truncated.length;
  const note = omitted > 0 ? ` (${omitted} more rows omitted)` : "";
  return (
    message.content +
    `\n\n[Query Results]${note}\ncolumns: ${JSON.stringify(message.columns)}\nrows: ${JSON.stringify(truncated)}`
  );
}

export function toLangChainMessages(history: AgentHistoryMessage[]) {
  // Only the most recent turns are replayed. The full transcript was re-sent on
  // every call and grew without bound.
  const windowed =
    history.length > MAX_HISTORY_MESSAGES
      ? history.slice(history.length - MAX_HISTORY_MESSAGES)
      : history;

  return windowed.map((message) => {
    switch (message.role) {
      case "assistant":
        return new AIMessage(withTableData(message));
      case "system":
        return new SystemMessage(message.content);
      default:
        return new HumanMessage(message.content);
    }
  });
}


