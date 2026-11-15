import { normalizeQuestion } from "../../utils/text.js";

export function tokenizeQuestion(question: string) {
  return normalizeQuestion(question)
    .replace(/[^\w\s-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}
