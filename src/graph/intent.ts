import { createHash } from "node:crypto";
import type { AgentHistoryMessage } from "../types.js";
import { TEMPORAL_PATTERNS } from "../database/row-inference.js";
import { dedupeRecipeKeys, normalizeQuestion } from "../utils/text.js";
import type { DerivedDimensionRecipeKey, IntentDecision, VisualizationRequest } from "./types.js";
import { normalizeVisualizationRequest } from "./visualization.js";

const SMALL_TALK_PATTERNS = [
  /^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening)\b/i,
  /\bhow are you\b/i,
  /\bwho are you\b/i,
  /\bwhat can you do\b/i,
  /\bhelp me\b/i,
  /\bthank(s| you)\b/i,
];

const VISUALIZATION_PATTERNS = [
  /\bvisuali[sz]e\b/i,
  /\bchart\b/i,
  /\bgraph\b/i,
  /\bplot\b/i,
  /\bdashboard\b/i,
  /\bcompare visually\b/i,
];

const ANALYTICAL_HINT_PATTERNS = [
  /\b(by|per|across|vs|versus|compare|comparison|trend|top|bottom|count|total|sum|average|avg|most|least|highest|lowest|which|what|who|over time|through time|across time)\b/i,
];

const SHORT_VISUALIZATION_PATTERNS = [
  /\bvisuali[sz]e\b/i,
  /\bchart\b/i,
  /\bgraph\b/i,
  /\bplot\b/i,
];

const RANKING_METRIC_HINTS = [
  /\b(sales|revenue|orders?|count|total|amount|profit|score|value|visits?|clicks?|purchases?|downloads?|views?)\b/i,
];

function tokenizeQuestion(question: string) {
  return normalizeQuestion(question)
    .replace(/[^\w\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function levenshteinDistance(left: string, right: string) {
  if (left === right) {
    return 0;
  }
  if (left.length === 0) {
    return right.length;
  }
  if (right.length === 0) {
    return left.length;
  }

  const previousRow = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let i = 1; i <= left.length; i += 1) {
    const currentRow = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      currentRow[j] = Math.min(
        currentRow[j - 1] + 1,
        previousRow[j] + 1,
        previousRow[j - 1] + cost,
      );
    }

    for (let j = 0; j <= right.length; j += 1) {
      previousRow[j] = currentRow[j];
    }
  }

  return previousRow[right.length];
}

function isVisualizationKeyword(word: string) {
  if (SHORT_VISUALIZATION_PATTERNS.some((pattern) => pattern.test(word))) {
    return true;
  }

  return (
    levenshteinDistance(word, "visualize") <= 3 ||
    levenshteinDistance(word, "visualise") <= 3 ||
    levenshteinDistance(word, "visualization") <= 4 ||
    levenshteinDistance(word, "visualisation") <= 4
  );
}

function buildVisualizationRequestFromQuestion(question: string) {
  const normalized = normalizeQuestion(question);
  const tokens = tokenizeQuestion(question);
  const categoryFields: string[] = [];
  let metricField: string | null =
    tokens.includes("count")
      ? "count"
      : tokens.includes("total")
        ? "total"
        : tokens.includes("sum")
          ? "sum"
          : tokens.includes("average") || tokens.includes("avg")
            ? "average"
            : null;

  const pushCategory = (value: string | null | undefined) => {
    if (typeof value !== "string") {
      return;
    }

    const normalizedValue = value.trim().replace(/\s+/g, " ");
    if (normalizedValue && !categoryFields.includes(normalizedValue)) {
      categoryFields.push(normalizedValue);
    }
  };

  const isQuestionWord = (value: string) => /^(what|who|which)$/i.test(value.trim());
  const isAuxiliaryWord = (value: string) =>
    /^(are|is|were|was|do|does|did|had|has|have|the|a|an)$/i.test(value.trim());

  const categoryClause = normalized.match(
    /\b(?:by|per|across|for|vs|versus)\s+([a-z0-9 _-]+?)(?=$|[,.!?;:]|\b(?:where|when|with|using|over)\b)/i,
  );
  if (categoryClause?.[1]) {
    const fields = categoryClause[1]
      .split(/\s*(?:,|and|&)\s*/i)
      .map((field) => field.trim())
      .filter(Boolean);
    categoryFields.push(...fields);
  }

  const rankingBeforeClause = normalized.match(
    /^(?:which|what|who)?\s*([a-z0-9 _-]+?)\s+(?:had|has|have|were|was|with|of|for)\s+(?:the\s+)?(?:most|least|highest|lowest|top|bottom)\s+([a-z0-9 _-]+?)(?=$|[,.!?;:])/i,
  );
  if (rankingBeforeClause?.[1]) {
    const rankingSubject = rankingBeforeClause[1].trim().replace(/\s+/g, " ");
    if (rankingSubject && !isQuestionWord(rankingSubject) && !isAuxiliaryWord(rankingSubject)) {
      if (RANKING_METRIC_HINTS.some((pattern) => pattern.test(rankingSubject))) {
        if (metricField === null) {
          metricField = rankingSubject;
        }
      } else {
        pushCategory(rankingSubject);
        if (metricField === null) {
          metricField = "count";
        }
      }
    }
  }
  if (rankingBeforeClause?.[2] && metricField === null) {
    const rankingMetric = rankingBeforeClause[2].trim().replace(/\s+/g, " ");
    if (rankingMetric) {
      metricField = rankingMetric;
    }
  }

  const rankingMetricOnlyClause = normalized.match(
    /^(?:what|who|which)\s+(?:had|has|have|were|was)\s+(?:the\s+)?(?:most|least|highest|lowest|top|bottom)\s+([a-z0-9 _-]+?)(?=$|[,.!?;:])/i,
  );
  if (rankingMetricOnlyClause?.[1] && metricField === null) {
    const rankingMetric = rankingMetricOnlyClause[1].trim().replace(/\s+/g, " ");
    if (rankingMetric) {
      metricField = rankingMetric;
    }
  }

  const rankingAfterClause = normalized.match(
    /^(?:which|what|who)?\s*(?:are|is|were|was|do|does|did|had|has|have)?\s*(?:the\s+)?(?:top|bottom|highest|lowest|most|least)\s+([a-z0-9 _-]+?)(?=$|[,.!?;:])/i,
  );
  if (rankingAfterClause?.[1]) {
    const rankingSubject = rankingAfterClause[1].trim().replace(/\s+/g, " ");
    if (rankingSubject) {
      if (RANKING_METRIC_HINTS.some((pattern) => pattern.test(rankingSubject))) {
        if (metricField === null) {
          metricField = rankingSubject;
        }
      } else {
        pushCategory(rankingSubject);
        if (metricField === null) {
          metricField = "count";
        }
      }
    }
  }

  const topOnlyClause = normalized.match(
    /^(?:top|bottom)\s+([a-z0-9 _-]+?)(?=$|[,.!?;:])/i,
  );
  if (topOnlyClause?.[1]) {
    const rankingSubject = topOnlyClause[1].trim().replace(/\s+/g, " ");
    if (rankingSubject) {
      if (RANKING_METRIC_HINTS.some((pattern) => pattern.test(rankingSubject))) {
        if (metricField === null) {
          metricField = rankingSubject;
        }
      } else {
        pushCategory(rankingSubject);
        if (metricField === null) {
          metricField = "count";
        }
      }
    }
  }

  const temporalClause = normalized.match(
    /^(.*?)(?:\b(?:over time|through time|across time)\b)(.*)$/i,
  );
  if (temporalClause?.[1]) {
    const subject = temporalClause[1]
      .replace(/^(?:show|plot|chart|graph|visualize|visualise|display|compare|analyze|analyse)\s+/i, "")
      .trim();
    if (subject) {
      const inferredMetric = subject
        .replace(/\b(?:the|a|an|of|by|for|in|on|with)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
      pushCategory("time");
      if (inferredMetric && metricField === null) {
        metricField = inferredMetric;
      }
    }
  }

  const dedupedCategoryFields = categoryFields.filter(
    (field, index) => categoryFields.indexOf(field) === index,
  );

  const seriesField = normalized.includes("series") ? "series" : null;
  const groupField = normalized.includes("group") ? "group" : null;
  const networkViewRequested = /\b(network|relationship|connections?)\b/i.test(normalized);

  const request = normalizeVisualizationRequest({
    categoryFields: dedupedCategoryFields,
    metricField,
    seriesField,
    groupField,
    networkViewRequested,
  });

  return request.categoryFields.length > 0 ||
    request.metricField !== null ||
    request.seriesField !== null ||
    request.groupField !== null ||
    request.networkViewRequested
    ? request
    : null;
}

export function buildHistoryDigest(history: AgentHistoryMessage[]) {
  const recentHistory = history
    .slice(-6)
    .map((message) => ({
      role: message.role,
      content: normalizeQuestion(message.content),
    }));

  return createHash("sha256").update(JSON.stringify(recentHistory)).digest("hex");
}

export function inferDerivedDimensionRecipeKeysFromText(text: string) {
  const normalized = normalizeQuestion(text);
  const keys: DerivedDimensionRecipeKey[] = [];

  if (/\bbody[_\s-]?group\b/i.test(normalized)) {
    keys.push("body_group");
  }

  return dedupeRecipeKeys(keys);
}

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

function isShortVisualizationFollowup(question: string, history: AgentHistoryMessage[]) {
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

export function needsImplicitCountMetric(
  intent: IntentDecision,
  availableColumns: string[],
) {
  if (intent.kind !== "explicit_visualization" && intent.kind !== "visualization_followup") {
    return false;
  }

  const likelyCategoryColumns = availableColumns.filter((column) =>
    /\b(country|city|state|region|category|type|name|status|provider)\b/i.test(column),
  );

  return likelyCategoryColumns.length > 0;
}

export function shouldAutoPlanChart(input: {
  question: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
}) {
  const { question, columns, rows } = input;
  if (rows.length < 2 || columns.length < 2) {
    return false;
  }

  const numericColumns = columns.filter((column) =>
    rows.some((row) => typeof row[column] === "number"),
  );
  const textColumns = columns.filter((column) =>
    rows.some((row) => typeof row[column] === "string"),
  );

  if (numericColumns.length === 0) {
    return false;
  }

  if (rows.length === 1) {
    return false;
  }

  if (numericColumns.length === 1 && textColumns.length === 1) {
    if (rows.length > 12) {
      return false;
    }

    return /\b(top|bottom|by|compare|comparison|ranking|rank|trend|over time)\b/i.test(
      question,
    );
  }

  if (numericColumns.length >= 2) {
    return /\b(compare|comparison|relationship|correlation|distribution|trend)\b/i.test(
      question,
    );
  }

  return TEMPORAL_PATTERNS.some((pattern) => pattern.test(question));
}

export function collectDerivedDimensionKeys(
  question: string,
  visualizationRequest: VisualizationRequest | null | undefined,
) {
  const derivedKeys = new Set(inferDerivedDimensionRecipeKeysFromText(question));

  for (const field of visualizationRequest?.categoryFields ?? []) {
    for (const key of inferDerivedDimensionRecipeKeysFromText(field)) {
      derivedKeys.add(key);
    }
  }

  for (const field of [visualizationRequest?.seriesField, visualizationRequest?.groupField]) {
    if (!field) {
      continue;
    }

    for (const key of inferDerivedDimensionRecipeKeysFromText(field)) {
      derivedKeys.add(key);
    }
  }

  return [...derivedKeys];
}
