import { IntentDecision } from "../../graph/types.js";
import { AgentHistoryMessage } from "../../types.js";
import { extractLastAnalyzableAnalyticalTurn, isShortVisualizationFollowup } from "./history.js";
import { SMALL_TALK_PATTERNS, VISUALIZATION_PATTERNS } from "./patterns.js";
import { buildVisualizationRequestFromQuestion } from "./visualization-request.js";


export function classifyIntentHeuristically(
  question: string,
  history: AgentHistoryMessage[] = [],
): IntentDecision {
  const normalized = question.trim();

  if (SMALL_TALK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { kind: "small_talk", wantsVisualization: false, visualizationRequest: null };
  }

  const priorTurn = extractLastAnalyzableAnalyticalTurn(history);

  if (isShortVisualizationFollowup(question, history)) {
    return {
      kind: "visualization_followup",
      wantsVisualization: true,
      visualizationRequest: priorTurn?.visualizationRequest ?? null,
    };
  }

  if (VISUALIZATION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return {
      kind: "explicit_visualization",
      wantsVisualization: true,
      visualizationRequest:
        buildVisualizationRequestFromQuestion(question) ?? priorTurn?.visualizationRequest ?? null,
    };
  }

  return { kind: "data_answer", wantsVisualization: false, visualizationRequest: null };
}