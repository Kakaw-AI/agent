import { AgentHistoryMessage } from "../../types.js";
import { normalizeQuestion } from "../../utils/text.js";
import { ANALYTICAL_HINT_PATTERNS, SHORT_VISUALIZATION_PATTERNS, SMALL_TALK_PATTERNS } from "./patterns.js";
import { isVisualizationKeyword, tokenizeQuestion } from "./text.js";
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

    const normalized = normalizeQuestion(message.content);
    if (SMALL_TALK_PATTERNS.some((pattern) => pattern.test(normalized))) {
      continue;
    }
    if (!ANALYTICAL_HINT_PATTERNS.some((pattern) => pattern.test(normalized))) {
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

export function isShortVisualizationFollowup(question: string, history: AgentHistoryMessage[]) {
  const normalized = normalizeQuestion(question);
  const tokens = tokenizeQuestion(question);

  if (tokens.length === 0 || tokens.length > 4) {
    return false;
  }

  if (!extractLastAnalyzableAnalyticalTurn(history)) {
    return false;
  }

  return tokens.some((token) => isVisualizationKeyword(token)) || SHORT_VISUALIZATION_PATTERNS.some((pattern) => pattern.test(normalized));
}