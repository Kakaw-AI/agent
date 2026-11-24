import { normalizeVisualizationRequest } from "../../graph/visualization.js";
import { normalizeQuestion } from "../../utils/text.js";
import { RANKING_METRIC_HINTS } from "./patterns.js";
import { tokenizeQuestion } from "./text.js";

const CHART_TYPE = String.raw`(?:bar|column|line|pie|donut|doughnut|scatter|area)`;
const CHART_NOUN = String.raw`(?:charts?|graphs?|plots?|histograms?|scatterplots?|visuali[sz]ations?)`;

/**
 * How to draw the answer, not what to query: "as a bar chart", "in a pie
 * chart", "show me a chart of". The chart planner reads the type from the
 * message itself; here it is removed so it cannot become a field. Left in,
 * "for each month last quarter as a bar chart" became a category field and
 * the SQL step aliased the month column with that whole phrase.
 */
const PRESENTATION_PHRASES = [
  new RegExp(String.raw`\b(?:as|in|into|on|using|with)\s+(?:an?\s+|the\s+)?(?:${CHART_TYPE}\s+)?${CHART_NOUN}`, "gi"),
  /\bas\s+(?:an?\s+)?(?:bars?|line|pie|donut|doughnut)\b/gi,
  new RegExp(
    String.raw`^(?:please\s+)?(?:(?:show|give|draw|make|plot|create|display|build)\s+)?(?:me\s+)?(?:an?\s+|the\s+)?(?:${CHART_TYPE}\s+)?${CHART_NOUN}\s+(?:of|for|showing|with)\s+`,
    "i",
  ),
];

/** Ends a "by/per/for <field>" clause: a filter or time range, not part of the field name. */
const CATEGORY_CLAUSE_END = String.raw`where|when|with|using|over|as|in|during|since|from|between|before|after|last|this|next|past|previous|ytd`;

export function stripPresentationPhrases(question: string) {
  return PRESENTATION_PHRASES.reduce((text, pattern) => text.replace(pattern, " "), question)
    .replace(/\s+/g, " ")
    .trim();
}

export function buildVisualizationRequestFromQuestion(question: string) {
  question = stripPresentationPhrases(question);
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
    new RegExp(
      String.raw`\b(?:by|per|across|for|vs|versus)\s+(?:(?:each|every)\s+)?([a-z0-9 _-]+?)(?=$|[,.!?;:]|\b(?:${CATEGORY_CLAUSE_END})\b)`,
      "i",
    ),
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
