export function buildNoRowsAnswer(input: { question: string; sql?: string | null }) {
  return [
    `I ran a read-only query against the selected database for "${input.question}", but it returned no matching rows.`,
    "That usually means the dataset does not contain records that match the requested filters, wording, or time range.",
    "If you want, I can try a broader version of the same question next.",
  ].join(" ");
}

export function buildDirectAnswer(question: string) {
  if (/\bwho are you\b/i.test(question) || /\bwhat can you do\b/i.test(question)) {
    return "I can answer questions about your connected database, explain results, and build charts when a visual comparison is useful.";
  }

  if (/\bthank(s| you)\b/i.test(question)) {
    return "You're welcome. Ask another question about your database whenever you're ready.";
  }

  return "Hi there. Ask me a question about your connected database and I'll query it for you.";
}
