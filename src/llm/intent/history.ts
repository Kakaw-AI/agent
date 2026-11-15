import type { AgentHistoryMessage } from "../../types.js";
import { normalizeQuestion } from "../../utils/text.js";
import { ANALYTICAL_HINT_PATTERNS, isSmallTalk } from "./patterns.js";
import { buildVisualizationRequestFromQuestion } from "./visualization-request.js";

export function extractLastAnalyzableAnalyticalTurn(history: AgentHistoryMessage[]) {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];

    if (message.role !== "user") {
      continue;
    }

    const assistantReply = history[index + 1];
    if (!assistantReply || assistantReply.role !== "assistant" || !assistantReply.content.trim()) {
      continue;
    }

    if (isSmallTalk(message.content)) {
      continue;
    }
    if (!ANALYTICAL_HINT_PATTERNS.some((pattern) => pattern.test(normalizeQuestion(message.content)))) {
      continue;
    }

    const visualizationRequest = buildVisualizationRequestFromQuestion(message.content);
    if (!visualizationRequest) {
      continue;
    }

    return {
      userMessage: message.content,
      assistantMessage: assistantReply.content,
      visualizationRequest,
    };
  }

  return null;
}

export function extractRowsFromHistory(history: AgentHistoryMessage[]) {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const msg = history[i];
    if (msg.role === "assistant" && msg.rows && msg.rows.length > 0 && msg.columns) {
      return { rows: msg.rows, columns: msg.columns, sql: msg.sql };
    }
  }
  return null;
}

/**
 * The previous assistant turn asked the user something and ran no query. The
 * newest message is the reply, so asking again would loop.
 */
export function previousTurnAskedUser(history: AgentHistoryMessage[]): boolean {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const message = history[i];
    if (message.role === "assistant") {
      return !message.sql && message.content.trim().endsWith("?");
    }
  }
  return false;
}
