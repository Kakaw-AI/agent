// This module contains logic for assessing the SQL drafts generated for visualization requests, specifically checking if they include the required fields and if the selected fields are readable. It also includes a function to build an outcome when the agent fails to generate a valid SQL draft after multiple attempts.

import {
  IDENTIFIER_THRESHOLDS,
  identifiersMatch,
} from "../../database/identifier-match.js";
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

  // Compared tolerantly on purpose. Both sides are runtime strings — a field
  // name parsed from the question versus an alias the model chose — so an exact
  // match rejects `customerId` and `customer_ids` as "missing" and burns a draft
  // attempt regenerating SQL that was already correct. A genuinely different
  // field, such as `customer` for `customer_id`, still fails.
  const missingFields = getRequiredVisualizationFields(input.visualizationRequest).filter(
    (field) =>
      !selectedAliases.some((alias) =>
        identifiersMatch(alias, field, IDENTIFIER_THRESHOLDS.sqlAutoCorrect),
      ),
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

export function buildVisualizationSqlExhaustedOutcome(
  priorErrors: string[],
  didYouMean: Array<{ field: string; candidates: string[] }> = [],
) {
  // When the failure traces back to a field we could not find in the catalog,
  // name it and offer the closest columns. The generic message left users with
  // no idea which word was the problem.
  const unresolved = didYouMean.filter((entry) => entry.candidates.length > 0);
  const answer =
    unresolved.length > 0
      ? unresolved
          .map(
            (entry) =>
              `I couldn't find a column named "${entry.field}". Did you mean ${entry.candidates.join(" or ")}?`,
          )
          .join(" ")
      : "I couldn't produce SQL for this visualization that preserved all requested fields. Please narrow the request or rephrase it.";

  return {
    answer,
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
