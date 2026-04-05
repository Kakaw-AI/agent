import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AgentHistoryMessage } from "../types.js";

export function toRawMessages(history: AgentHistoryMessage[]) {
  return history.map((message) => ({
    role: message.role,
    content: message.content,
  }));
}



export function toLangChainMessages(history: AgentHistoryMessage[]) {
  return history.map((message) => {
    switch (message.role) {
      case "assistant":
        return new AIMessage(message.content);
      case "system":
        return new SystemMessage(message.content);
      default:
        return new HumanMessage(message.content);
    }
  });
}


