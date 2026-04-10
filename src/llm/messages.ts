import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AgentHistoryMessage } from "../types.js";

const MAX_HISTORY_ROWS = 50;

function withTableData(message: AgentHistoryMessage): string {
  if (message.role !== "assistant" || !message.rows || message.rows.length === 0 || !message.columns) {
    return message.content;
  }
  const truncated = message.rows.slice(0, MAX_HISTORY_ROWS);
  return (
    message.content +
    `\n\n[Query Results]\ncolumns: ${JSON.stringify(message.columns)}\nrows: ${JSON.stringify(truncated)}`
  );
}

export function toLangChainMessages(history: AgentHistoryMessage[]) {
  return history.map((message) => {
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


