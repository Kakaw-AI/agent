import { IDENTIFIER_THRESHOLDS } from "../database/identifier-match.js";
import type { SchemaIndex } from "../database/schema-index.js";
import type { VisualizationRequest } from "../types.js";
import type { FieldResolutionEntry, FieldResolutionKind } from "./types.js";

/**
 * Matches the field names parsed out of a question against the real catalog,
 * before any SQL is generated.
 *
 * Without this, a misspelled column reaches the SQL prompt verbatim and then
 * fails three exact-match assertions in a row, burning every draft attempt to
 * arrive at a generic "couldn't produce SQL" message. Correcting it here costs
 * no LLM call and removes those wasted attempts.
 */

/**
 * Placeholders the question parser invents, which are aggregation intents and
 * layout roles rather than column names.
 *
 * This guard is the highest-consequence part of the module: `total` scores well
 * against a `total_amount` column, and resolving it would quietly turn a SUM
 * into a plain column reference.
 */
export const RESERVED_VISUALIZATION_TOKENS: ReadonlySet<string> = new Set([
  "count",
  "total",
  "sum",
  "average",
  "avg",
  "time",
  "series",
  "group",
]);

export type ResolvedVisualizationRequest = {
  /** The request rewritten to catalog-exact names. */
  request: VisualizationRequest;
  /** The request as parsed, for the trace. */
  original: VisualizationRequest;
  entries: FieldResolutionEntry[];
  corrections: Array<{ from: string; to: string }>;
  unresolved: string[];
  didYouMean: Array<{ field: string; candidates: string[] }>;
};

type SlotName = FieldResolutionEntry["slot"];

function resolveField(
  value: string,
  slot: SlotName,
  index: number,
  schema: SchemaIndex,
): FieldResolutionEntry {
  const original = value.trim();

  const base: FieldResolutionEntry = {
    slot,
    index,
    original,
    resolved: original,
    qualifiedName: null,
    score: 0,
    kind: "unchanged",
    suggestions: [],
  };

  if (!original) {
    return base;
  }

  if (RESERVED_VISUALIZATION_TOKENS.has(original.toLowerCase())) {
    return { ...base, kind: "reserved" };
  }

  const resolution = schema.resolveColumn(original, {
    minScore: IDENTIFIER_THRESHOLDS.suggestFloor,
  });

  if (!resolution) {
    return { ...base, kind: "unresolved" };
  }

  const suggestions = schema
    .suggestColumns(original)
    .map((entry) => entry.qualifiedName);

  // Already a real column: adopt the catalog's exact spelling so the
  // downstream alias comparisons line up, but report it as unchanged.
  if (resolution.exact) {
    return {
      ...base,
      resolved: resolution.column.name,
      qualifiedName: resolution.column.qualifiedName,
      score: resolution.score,
      kind: "unchanged",
    };
  }

  if (
    resolution.score >= IDENTIFIER_THRESHOLDS.autoAccept &&
    !resolution.ambiguous
  ) {
    return {
      ...base,
      resolved: resolution.column.name,
      qualifiedName: resolution.column.qualifiedName,
      score: resolution.score,
      kind: "corrected",
    };
  }

  // Either two columns are equally plausible or the best match is only a hint.
  // Both cases keep the user's wording and hand the candidates to the model.
  const kind: FieldResolutionKind = resolution.ambiguous
    ? "ambiguous"
    : "unresolved";

  return { ...base, score: resolution.score, kind, suggestions };
}

export function resolveVisualizationRequestFields(
  request: VisualizationRequest | null,
  schema: SchemaIndex,
): ResolvedVisualizationRequest | null {
  if (!request) {
    return null;
  }

  const entries: FieldResolutionEntry[] = [];

  const categoryFields = request.categoryFields.map((field, position) => {
    const entry = resolveField(field, "category", position, schema);
    entries.push(entry);
    return entry.resolved ?? field;
  });

  const resolveSingle = (
    value: string | null,
    slot: SlotName,
  ): string | null => {
    if (!value) {
      return value;
    }
    const entry = resolveField(value, slot, 0, schema);
    entries.push(entry);
    return entry.resolved ?? value;
  };

  const resolved: VisualizationRequest = {
    ...request,
    categoryFields,
    metricField: resolveSingle(request.metricField, "metric"),
    seriesField: resolveSingle(request.seriesField, "series"),
    groupField: resolveSingle(request.groupField, "group"),
  };

  const corrections = entries
    .filter((entry) => entry.kind === "corrected" && entry.resolved)
    .map((entry) => ({ from: entry.original, to: entry.resolved as string }));

  const unresolved = entries
    .filter((entry) => entry.kind === "unresolved" || entry.kind === "ambiguous")
    .map((entry) => entry.original);

  const didYouMean = entries
    .filter(
      (entry) =>
        (entry.kind === "unresolved" || entry.kind === "ambiguous") &&
        entry.suggestions.length > 0,
    )
    .map((entry) => ({ field: entry.original, candidates: entry.suggestions }));

  return { request: resolved, original: request, entries, corrections, unresolved, didYouMean };
}

/**
 * Rebuilds the "did you mean" list from state, for layers that see the
 * resolution entries but not the resolution object.
 */
export function didYouMeanFromEntries(
  entries: readonly FieldResolutionEntry[],
): Array<{ field: string; candidates: string[] }> {
  return entries
    .filter(
      (entry) =>
        (entry.kind === "unresolved" || entry.kind === "ambiguous") &&
        entry.suggestions.length > 0,
    )
    .map((entry) => ({ field: entry.original, candidates: entry.suggestions }));
}

/** Human-readable summary for an `agent_step`, or null when nothing changed. */
export function describeFieldResolution(
  resolution: ResolvedVisualizationRequest | null,
): string | null {
  if (!resolution) {
    return null;
  }

  if (resolution.corrections.length > 0) {
    const shown = resolution.corrections
      .slice(0, 3)
      .map((entry) => `"${entry.from}" as "${entry.to}"`)
      .join(", ");
    const extra =
      resolution.corrections.length > 3
        ? ` (+${resolution.corrections.length - 3} more)`
        : "";
    return `Interpreted ${shown} from the schema.${extra}`;
  }

  if (resolution.didYouMean.length > 0) {
    const first = resolution.didYouMean[0];
    return `Couldn't match "${first.field}" to a column — closest are ${first.candidates.join(", ")}.`;
  }

  return null;
}
