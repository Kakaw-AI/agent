/**
 * String primitives for comparing database identifiers.
 *
 * Deliberately catalog-free so it can be imported from `database/`, `graph/`
 * and `prompts/` without dragging the catalog types along, and so it is
 * testable in isolation.
 *
 * Plain edit distance is a poor fit for identifiers on its own: it cannot tell
 * `customer_ids` from `customer_id` cheaply, and it rates `order_date` against
 * `date_of_order` as barely related. Matching therefore runs in stages, from
 * structural equality down to a fuzzy composite, and every structural stage
 * outranks every fuzzy result.
 */

export type IdentifierMatchKind =
  | "exact"
  | "normalized"
  | "token"
  | "reordered"
  | "fuzzy";

export type IdentifierMatch = {
  score: number;
  kind: IdentifierMatchKind;
};

export const IDENTIFIER_THRESHOLDS = {
  /**
   * Rewriting a name the user typed in natural language. One keystroke error in
   * a typical 8-16 character snake_case identifier scores around 0.90; two
   * errors in an 8 character name score around 0.78. This sits in that gap.
   */
  autoAccept: 0.86,
  /**
   * Rewriting an identifier inside SQL the model generated. Deliberately
   * stricter than `autoAccept`: a wrong rewrite here returns confidently wrong
   * data, where a wrong rewrite of a parsed noun merely fails.
   */
  sqlAutoCorrect: 0.9,
  /** Below this, overlap is coincidental and not worth showing as a suggestion. */
  suggestFloor: 0.62,
  /** A runner-up this close to the best match means the choice is not ours to make. */
  ambiguityMargin: 0.04,
  /** Fuzzing `id`, `dt` or `qty` produces noise, so short names get structural stages only. */
  minFuzzyLength: 3,
} as const;

/** Highest score the fuzzy composite may return, so structural stages always win. */
const MAX_FUZZY_SCORE = 0.93;

const TOKEN_STOPWORDS = new Set([
  "of",
  "the",
  "a",
  "an",
  "by",
  "per",
  "for",
  "in",
  "on",
  "to",
  "and",
  "is",
]);

/**
 * The single normalizer for identifiers. Folds quoting, diacritics, camelCase
 * and punctuation into lower snake_case.
 */
export function normalizeIdentifier(value: string): string {
  if (!value) {
    return "";
  }

  const trimmed = value.trim();
  const unquoted = trimmed.replace(/^["'`]+/, "").replace(/["'`]+$/, "");

  const normalized = unquoted
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

  if (normalized) {
    return normalized;
  }

  // Identifiers written entirely in a non-latin script reduce to an empty
  // string under the ascii filter. Falling back to a case-folded trim keeps
  // them comparable to each other instead of collapsing every one of them
  // onto "".
  return trimmed.toLowerCase();
}

/**
 * Common identifier words that are already singular despite ending in `s`.
 * `status` is the one that matters most — stripping it to `statu` would make
 * every status column mismatch.
 */
const ALREADY_SINGULAR = new Set([
  "series",
  "species",
  "status",
  "address",
  "index",
  "data",
  "media",
  "news",
]);

function singularize(token: string): string {
  if (token.length < 3 || ALREADY_SINGULAR.has(token)) {
    return token;
  }
  // -us (status, bonus), -ss (class, address), -is (analysis, basis),
  // -as (alias, gas) are singular endings, not plurals.
  if (/(?:us|ss|is|as)$/.test(token)) {
    return token;
  }
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }
  if (/[sxz]es$/.test(token)) {
    return token.slice(0, -2);
  }
  if (token.endsWith("s")) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Splits an identifier into comparable word tokens, dropping connective words
 * and folding simple plurals. This is what makes `customer_ids` and
 * `customer_id` equivalent.
 */
export function identifierTokens(value: string): string[] {
  const parts = normalizeIdentifier(value).split("_").filter(Boolean);
  if (parts.length === 0) {
    return [];
  }

  const meaningful = parts.filter((part) => !TOKEN_STOPWORDS.has(part));
  const kept = meaningful.length > 0 ? meaningful : parts;
  return kept.map(singularize);
}

export function identifierKey(value: string): string {
  return identifierTokens(value).join("_");
}

export function identifierSortedKey(value: string): string {
  return [...identifierTokens(value)].sort().join("_");
}

/**
 * Damerau-Levenshtein (optimal string alignment). Transposition is the most
 * common identifier typo — `custoemr_id` — and plain Levenshtein charges two
 * edits for it.
 *
 * `maxDistance` bounds the work: once every cell in a row exceeds it the
 * result can only grow, so the walk stops early.
 */
export function damerauLevenshtein(
  a: string,
  b: string,
  maxDistance = Number.POSITIVE_INFINITY,
): number {
  if (a === b) {
    return 0;
  }
  if (a.length === 0) {
    return b.length;
  }
  if (b.length === 0) {
    return a.length;
  }
  if (Math.abs(a.length - b.length) > maxDistance) {
    return maxDistance + 1;
  }

  const width = b.length + 1;
  let twoRowsBack = new Int32Array(width);
  let previousRow = new Int32Array(width);
  let currentRow = new Int32Array(width);

  for (let j = 0; j < width; j += 1) {
    previousRow[j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    currentRow[0] = i;
    let rowMinimum = i;

    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(
        currentRow[j - 1] + 1,
        previousRow[j] + 1,
        previousRow[j - 1] + cost,
      );

      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        best = Math.min(best, twoRowsBack[j - 2] + 1);
      }

      currentRow[j] = best;
      if (best < rowMinimum) {
        rowMinimum = best;
      }
    }

    if (rowMinimum > maxDistance) {
      return maxDistance + 1;
    }

    const spent = twoRowsBack;
    twoRowsBack = previousRow;
    previousRow = currentRow;
    currentRow = spent;
  }

  return previousRow[b.length];
}

function editSimilarity(a: string, b: string): number {
  const longest = Math.max(a.length, b.length);
  if (longest === 0) {
    return 0;
  }
  const distance = damerauLevenshtein(a, b, Math.ceil(longest * 0.5));
  return Math.max(0, 1 - distance / longest);
}

function trigrams(value: string): Set<string> {
  // Space padding follows the pg_trgm convention so short names still produce
  // usable trigrams.
  const padded = `  ${value} `;
  const result = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i += 1) {
    result.add(padded.slice(i, i + 3));
  }
  return result;
}

function trigramSimilarity(a: string, b: string): number {
  const left = trigrams(a);
  const right = trigrams(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let shared = 0;
  for (const gram of left) {
    if (right.has(gram)) {
      shared += 1;
    }
  }
  return (2 * shared) / (left.size + right.size);
}

/**
 * Greedy bipartite match between two token lists. Token counts are tiny (rarely
 * above six), so repeatedly taking the strongest remaining pair is both cheap
 * and good enough.
 */
function tokenSimilarity(leftTokens: string[], rightTokens: string[]): number {
  if (leftTokens.length === 0 || rightTokens.length === 0) {
    return 0;
  }

  const usedRight = new Set<number>();
  const usedLeft = new Set<number>();
  let matched = 0;

  for (;;) {
    let bestScore = 0;
    let bestLeft = -1;
    let bestRight = -1;

    for (let i = 0; i < leftTokens.length; i += 1) {
      if (usedLeft.has(i)) {
        continue;
      }
      for (let j = 0; j < rightTokens.length; j += 1) {
        if (usedRight.has(j)) {
          continue;
        }
        const score = editSimilarity(leftTokens[i], rightTokens[j]);
        if (score > bestScore) {
          bestScore = score;
          bestLeft = i;
          bestRight = j;
        }
      }
    }

    if (bestLeft === -1 || bestScore < 0.75) {
      break;
    }

    usedLeft.add(bestLeft);
    usedRight.add(bestRight);
    matched += bestScore;
  }

  return (2 * matched) / (leftTokens.length + rightTokens.length);
}

/** Similarity plus the stage that produced it. */
export function identifierSimilarityDetail(a: string, b: string): IdentifierMatch {
  if (a === b) {
    return { score: 1, kind: "exact" };
  }

  const normalizedA = normalizeIdentifier(a);
  const normalizedB = normalizeIdentifier(b);
  if (!normalizedA || !normalizedB) {
    return { score: 0, kind: "fuzzy" };
  }
  if (normalizedA === normalizedB) {
    return { score: 0.99, kind: "normalized" };
  }

  const tokensA = identifierTokens(a);
  const tokensB = identifierTokens(b);

  if (tokensA.join("_") === tokensB.join("_")) {
    return { score: 0.97, kind: "token" };
  }
  if (
    tokensA.length > 0 &&
    [...tokensA].sort().join("_") === [...tokensB].sort().join("_")
  ) {
    return { score: 0.94, kind: "reordered" };
  }

  const shortest = Math.min(normalizedA.length, normalizedB.length);
  if (shortest < IDENTIFIER_THRESHOLDS.minFuzzyLength) {
    return { score: 0, kind: "fuzzy" };
  }

  // A small *absolute* number of edits is the signature of a typo, and length
  // ratios badly understate it on short names: one slip in `regoin` scores only
  // 1 - 1/6 under a ratio, which would leave an obvious typo uncorrected.
  const nearMissDistance = damerauLevenshtein(normalizedA, normalizedB, 2);
  if (nearMissDistance === 1 && shortest >= 4) {
    return { score: 0.9, kind: "fuzzy" };
  }
  if (nearMissDistance === 2 && shortest >= 8) {
    return { score: 0.87, kind: "fuzzy" };
  }

  // The user named part of the column: every token of the shorter name has a
  // counterpart in the longer one (`price` inside `product_price`). Worth
  // offering as a suggestion, never worth applying silently — `total` and
  // `total_amount` are not interchangeable.
  const subset = tokenSubsetScore(tokensA, tokensB);
  if (subset !== null) {
    return { score: subset, kind: "fuzzy" };
  }

  const longest = Math.max(normalizedA.length, normalizedB.length);
  const isPrefixPair =
    normalizedA.startsWith(normalizedB) || normalizedB.startsWith(normalizedA);

  if (!isPrefixPair && longest - shortest > Math.max(3, Math.floor(longest * 0.4))) {
    return { score: 0, kind: "fuzzy" };
  }

  const prefixBonus = isPrefixPair && shortest / longest >= 0.6 ? 0.05 : 0;
  const score =
    0.55 * editSimilarity(normalizedA, normalizedB) +
    0.35 * tokenSimilarity(tokensA, tokensB) +
    0.1 * trigramSimilarity(normalizedA, normalizedB) +
    prefixBonus;

  return {
    score: Math.min(MAX_FUZZY_SCORE, Math.max(0, score)),
    kind: "fuzzy",
  };
}

/** Lowest and highest score the token-subset stage can produce. */
const SUBSET_MIN_SCORE = 0.62;
const SUBSET_MAX_SCORE = 0.8;

/**
 * Scores the case where one name's tokens are all present in the other's, with
 * strictly fewer tokens. Returns null when that does not hold.
 *
 * The score stays inside the suggestion band on purpose: naming a subset of a
 * column is a strong hint but a weak identification.
 */
function tokenSubsetScore(
  tokensA: string[],
  tokensB: string[],
): number | null {
  const [shorter, longer] =
    tokensA.length <= tokensB.length ? [tokensA, tokensB] : [tokensB, tokensA];

  if (shorter.length === 0 || shorter.length >= longer.length) {
    return null;
  }

  const available = [...longer];
  for (const token of shorter) {
    const index = available.findIndex(
      (candidate) =>
        identifierSimilarity(token, candidate) >= IDENTIFIER_THRESHOLDS.autoAccept,
    );
    if (index === -1) {
      return null;
    }
    available.splice(index, 1);
  }

  const coverage = shorter.length / longer.length;
  return SUBSET_MIN_SCORE + (SUBSET_MAX_SCORE - SUBSET_MIN_SCORE) * coverage;
}

export function identifierSimilarity(a: string, b: string): number {
  return identifierSimilarityDetail(a, b).score;
}

export function identifiersMatch(
  a: string,
  b: string,
  minScore: number = IDENTIFIER_THRESHOLDS.autoAccept,
): boolean {
  return identifierSimilarity(a, b) >= minScore;
}

export type BestMatch<T> = {
  item: T;
  score: number;
  kind: IdentifierMatchKind;
  /** Best score among candidates that resolve to a *different* identifier. */
  runnerUpScore: number;
};

/**
 * Best scoring entry in `pool`, along with the strongest competing alternative
 * that is not the same identifier. Callers use `runnerUpScore` to refuse to
 * auto-correct when two catalog entries are equally plausible.
 */
export function bestMatch<T>(
  candidate: string,
  pool: readonly T[],
  toName: (item: T) => string,
  minScore: number = IDENTIFIER_THRESHOLDS.autoAccept,
): BestMatch<T> | null {
  let best: { item: T; score: number; kind: IdentifierMatchKind; key: string } | null =
    null;
  let runnerUp: { score: number; key: string } | null = null;

  for (const item of pool) {
    const name = toName(item);
    if (!name) {
      continue;
    }

    const { score, kind } = identifierSimilarityDetail(candidate, name);
    if (score <= 0) {
      continue;
    }

    // Keyed on the raw name: two spellings that normalize alike (`customer_id`
    // and `customers_id`) are still two different columns, and picking between
    // them is exactly the ambiguity callers need to hear about. Repeated
    // identical names — `id` across many tables — are one candidate here;
    // table-level ambiguity is the schema index's job.
    const key = name;

    if (!best || score > best.score) {
      if (best && best.key !== key) {
        runnerUp = { score: best.score, key: best.key };
      }
      best = { item, score, kind, key };
      continue;
    }

    if (key !== best.key && (!runnerUp || score > runnerUp.score)) {
      runnerUp = { score, key };
    }
  }

  if (!best || best.score < minScore) {
    return null;
  }

  return {
    item: best.item,
    score: best.score,
    kind: best.kind,
    runnerUpScore: runnerUp?.score ?? 0,
  };
}
