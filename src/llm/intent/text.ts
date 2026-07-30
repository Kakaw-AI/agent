import { normalizeQuestion } from "../../utils/text.js";
import { damerauLevenshtein } from "../../database/identifier-match.js";
import { SHORT_VISUALIZATION_PATTERNS } from "./patterns.js";

export function tokenizeQuestion(question: string) {
  return normalizeQuestion(question)
    .replace(/[^\w\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function isVisualizationKeyword(word: string) {
  if (SHORT_VISUALIZATION_PATTERNS.some((pattern) => pattern.test(word))) {
    return true;
  }

  // Damerau distance is never greater than plain Levenshtein, so these
  // thresholds only widen — transpositions like "visualzie" now cost one edit
  // instead of two.
  return (
    damerauLevenshtein(word, "visualize", 3) <= 3 ||
    damerauLevenshtein(word, "visualise", 3) <= 3 ||
    damerauLevenshtein(word, "visualization", 4) <= 4 ||
    damerauLevenshtein(word, "visualisation", 4) <= 4
  );
}
