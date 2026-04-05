import { normalizeQuestion } from "../../utils/text.js";
import { SHORT_VISUALIZATION_PATTERNS } from "./patterns.js";

export function tokenizeQuestion(question: string) {
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

export function isVisualizationKeyword(word: string) {
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
