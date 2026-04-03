import { createHash } from "node:crypto";
import type { AgentHistoryMessage } from "../types.js";

export type IntentKind = "small_talk" | "data_answer" | "explicit_visualization";

export type IntentDecision = {
  kind: IntentKind;
  wantsVisualization: boolean;
};

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

const TEMPORAL_PATTERNS = [
  /\bdate\b/i,
  /\bday\b/i,
  /\bweek\b/i,
  /\bmonth\b/i,
  /\byear\b/i,
  /\btime\b/i,
  /\btrend\b/i,
  /\bover time\b/i,
];

export function normalizeQuestion(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
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

export function classifyIntentHeuristically(question: string): IntentDecision {
  const normalized = question.trim();

  if (SMALL_TALK_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { kind: "small_talk", wantsVisualization: false };
  }

  if (VISUALIZATION_PATTERNS.some((pattern) => pattern.test(normalized))) {
    return { kind: "explicit_visualization", wantsVisualization: true };
  }

  return { kind: "data_answer", wantsVisualization: false };
}

export function needsImplicitCountMetric(
  intent: IntentDecision,
  availableColumns: string[],
) {
  if (intent.kind !== "explicit_visualization") {
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

  return "Hi there. Ask me a question about your connected database and I’ll query it for you.";
}

export function toReadableLabel(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
