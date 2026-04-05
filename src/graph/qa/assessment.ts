// This module contains logic for assessing the SQL drafts generated for visualization requests, specifically checking if they include the required fields and if the selected fields are readable. It also includes a function to build an outcome when the agent fails to generate a valid SQL draft after multiple attempts.

import type { SqlDraftAssessment, VisualizationSqlDraftInput } from "../types.js";
import { getRequiredVisualizationFields } from "../visualization.js";
import {
  extractFinalSelectClause,
  inferSqlSelectAlias,
  normalizeSqlIdentifier,
  splitSqlSelectList,
} from "./parser.js";

export function assessVisualizationSqlDraft(input: VisualizationSqlDraftInput): SqlDraftAssessment {
  if (!input.visualizationRequest) {
    return {
      ok: true,
      selectedAliases: [],
      missingFields: [],
      unreadableAliases: [],
      errors: [],
    };
  }

  const selectClause = extractFinalSelectClause(input.sql);
  if (!selectClause) {
    return {
      ok: false,
      selectedAliases: [],
      missingFields: getRequiredVisualizationFields(input.visualizationRequest),
      unreadableAliases: [],
      errors: ["The SQL draft does not contain a readable SELECT ... FROM projection."],
    };
  }

  const selectItems = splitSqlSelectList(selectClause);
  const selectedAliases = selectItems
    .map(inferSqlSelectAlias)
    .filter((value): value is string => Boolean(value))
    .map(normalizeSqlIdentifier);

  const unreadableAliases = selectItems
    .filter((item) => {
      const alias = inferSqlSelectAlias(item);
      return alias === null && /[()]/.test(item);
    })
    .map((item) => item.trim());

  const missingFields = getRequiredVisualizationFields(input.visualizationRequest).filter(
    (field) => !selectedAliases.includes(normalizeSqlIdentifier(field)),
  );

  const errors = [
    ...missingFields.map((field) => `The SQL draft is missing requested field "${field}".`),
    ...unreadableAliases.map(
      (item) =>
        `The SQL draft must use a readable alias for computed fields instead of "${item}".`,
    ),
  ];

  return {
    ok: errors.length === 0,
    selectedAliases,
    missingFields,
    unreadableAliases,
    errors,
  };
}

export function buildVisualizationSqlExhaustedOutcome(priorErrors: string[]) {
  return {
    answer:
      "I couldn't produce SQL for this visualization that preserved all requested fields. Please narrow the request or rephrase it.",
    visualizationValidationStatus: "invalid" as const,
    visualizationValidationErrors: priorErrors,
    narrowedVisualizationReason: "The generated SQL kept dropping requested visualization fields.",
    steps: [
      {
        text: "Failed to generate SQL that preserved the requested visualization fields.",
        at: new Date().toISOString(),
      },
    ],
  };
}
