import { describe, expect, it } from "vitest";
import {
  IDENTIFIER_THRESHOLDS,
  bestMatch,
  damerauLevenshtein,
  identifierKey,
  identifierSimilarity,
  identifierSimilarityDetail,
  identifierSortedKey,
  identifierTokens,
  identifiersMatch,
  normalizeIdentifier,
} from "../../src/database/identifier-match.js";

describe("normalizeIdentifier", () => {
  it("folds casing, camelCase, quoting and punctuation into snake_case", () => {
    expect(normalizeIdentifier("customerId")).toBe("customer_id");
    expect(normalizeIdentifier("CustomerID")).toBe("customer_id");
    expect(normalizeIdentifier("Customer_ID")).toBe("customer_id");
    expect(normalizeIdentifier('"weird name"')).toBe("weird_name");
    expect(normalizeIdentifier("total  amount")).toBe("total_amount");
    expect(normalizeIdentifier("order-date")).toBe("order_date");
  });

  it("strips diacritics", () => {
    expect(normalizeIdentifier("café_id")).toBe("cafe_id");
    expect(normalizeIdentifier("münchen")).toBe("munchen");
  });

  it("falls back to a case-folded trim for non-latin names instead of empty string", () => {
    // The old normalizer produced "" here, collapsing every such column onto
    // the same key.
    const normalized = normalizeIdentifier("订单编号");
    expect(normalized).not.toBe("");
    expect(normalized).toBe("订单编号");
  });

  it("returns empty string only for empty input", () => {
    expect(normalizeIdentifier("")).toBe("");
    expect(normalizeIdentifier("   ")).toBe("");
  });
});

describe("identifierTokens", () => {
  it("drops connective stopwords and folds simple plurals", () => {
    expect(identifierTokens("customer_ids")).toEqual(["customer", "id"]);
    expect(identifierTokens("date_of_order")).toEqual(["date", "order"]);
    expect(identifierTokens("statuses")).toEqual(["status"]);
    expect(identifierTokens("categories")).toEqual(["category"]);
    expect(identifierTokens("boxes")).toEqual(["box"]);
  });

  it("keeps stopwords when dropping them would empty the list", () => {
    expect(identifierTokens("by")).toEqual(["by"]);
  });

  it("produces an order-independent sorted key", () => {
    expect(identifierSortedKey("order_date")).toBe(identifierSortedKey("date_of_order"));
    expect(identifierKey("order_date")).not.toBe(identifierKey("date_of_order"));
  });
});

describe("damerauLevenshtein", () => {
  it("charges one edit for a transposition where Levenshtein charges two", () => {
    expect(damerauLevenshtein("custoemr", "customer")).toBe(1);
    expect(damerauLevenshtein("visualzie", "visualize")).toBe(1);
  });

  it("handles the trivial cases", () => {
    expect(damerauLevenshtein("abc", "abc")).toBe(0);
    expect(damerauLevenshtein("", "abc")).toBe(3);
    expect(damerauLevenshtein("abc", "")).toBe(3);
  });

  it("never reports below the true distance when bounded", () => {
    // A bounded call may overshoot the cap but must not understate a match.
    expect(damerauLevenshtein("aaaaaa", "bbbbbb", 2)).toBeGreaterThan(2);
  });
});

describe("identifierSimilarity staging", () => {
  it("ranks structural matches above any fuzzy match", () => {
    expect(identifierSimilarityDetail("customer_id", "customer_id")).toEqual({
      score: 1,
      kind: "exact",
    });
    expect(identifierSimilarityDetail("Customer_ID", "customer_id").kind).toBe(
      "normalized",
    );
    expect(identifierSimilarityDetail("customer_ids", "customer_id").kind).toBe(
      "token",
    );
    expect(identifierSimilarityDetail("order_date", "date_of_order").kind).toBe(
      "reordered",
    );

    const fuzzy = identifierSimilarityDetail("custmer_id", "customer_id");
    expect(fuzzy.kind).toBe("fuzzy");
    expect(fuzzy.score).toBeLessThan(
      identifierSimilarityDetail("order_date", "date_of_order").score,
    );
  });

  it("auto-accepts a single keystroke error regardless of name length", () => {
    // Scoring by edit-distance-over-length would rate a slip in a short name far
    // worse than the same slip in a long one, leaving obvious typos uncorrected.
    for (const [typo, actual] of [
      ["custmer_id", "customer_id"],
      ["custoemr_id", "customer_id"],
      ["total_reveneu", "total_revenue"],
      ["revenu", "revenue"],
      ["regoin", "region"],
      ["ordr", "order"],
    ] as const) {
      expect(identifierSimilarity(typo, actual)).toBeGreaterThanOrEqual(
        IDENTIFIER_THRESHOLDS.autoAccept,
      );
    }
  });

  it("accepts two errors in a long name but not in a short one", () => {
    expect(identifierSimilarity("prodcut_naem", "product_name")).toBeGreaterThanOrEqual(
      IDENTIFIER_THRESHOLDS.autoAccept,
    );
    expect(identifierSimilarity("cusmter_od", "customer_id")).toBeLessThan(
      IDENTIFIER_THRESHOLDS.suggestFloor,
    );
  });

  it("rejects unrelated names outright", () => {
    for (const [a, b] of [
      ["region", "sales_territory"],
      ["email", "name"],
      ["first_name", "last_name"],
    ] as const) {
      expect(identifierSimilarity(a, b)).toBeLessThan(
        IDENTIFIER_THRESHOLDS.autoAccept,
      );
    }
    expect(identifierSimilarity("region", "sales_territory")).toBe(0);
  });

  it("suggests but never auto-accepts a name that is a subset of the column", () => {
    // Naming part of a column is a strong hint and a weak identification:
    // `total` and `total_amount` are not interchangeable.
    for (const [a, b] of [
      ["total", "total_amount"],
      ["customer", "customer_id"],
      ["price", "product_price"],
      ["created", "created_at"],
      ["regoin", "sales_region"],
    ] as const) {
      const score = identifierSimilarity(a, b);
      expect(score).toBeLessThan(IDENTIFIER_THRESHOLDS.autoAccept);
      expect(score).toBeGreaterThanOrEqual(IDENTIFIER_THRESHOLDS.suggestFloor);
    }
  });

  it("degrades as errors accumulate", () => {
    const one = identifierSimilarity("custmer_id", "customer_id");
    const two = identifierSimilarity("cusmter_od", "customer_id");
    expect(one).toBeGreaterThan(two);
  });

  it("refuses to fuzz identifiers shorter than the minimum length", () => {
    expect(identifierSimilarity("dt", "date")).toBe(0);
    expect(identifierSimilarity("id", "id")).toBe(1);
  });

  it("is symmetric", () => {
    expect(identifierSimilarity("custmer_id", "customer_id")).toBeCloseTo(
      identifierSimilarity("customer_id", "custmer_id"),
      10,
    );
  });
});

describe("identifiersMatch", () => {
  it("treats alias spellings of the same field as equal", () => {
    expect(identifiersMatch("customer_id", "customerId", 0.9)).toBe(true);
    expect(identifiersMatch("customer_id", "customer_ids", 0.9)).toBe(true);
    expect(identifiersMatch("customer_id", "customer", 0.9)).toBe(false);
  });
});

describe("bestMatch", () => {
  const columns = [
    "customer_id",
    "customer_name",
    "created_at",
    "order_id",
    "total_amount",
  ];

  it("finds the closest column and reports no meaningful runner-up", () => {
    const result = bestMatch("custmer_id", columns, (c) => c);
    expect(result?.item).toBe("customer_id");
    expect(result!.score - result!.runnerUpScore).toBeGreaterThan(
      IDENTIFIER_THRESHOLDS.ambiguityMargin,
    );
  });

  it("reports a close runner-up when two columns are equally plausible", () => {
    const ambiguous = ["customer_id", "customers_id"];
    const result = bestMatch("custmer_id", ambiguous, (c) => c);
    expect(result).not.toBeNull();
    expect(result!.score - result!.runnerUpScore).toBeLessThanOrEqual(
      IDENTIFIER_THRESHOLDS.ambiguityMargin,
    );
  });

  it("returns null when nothing clears the threshold", () => {
    expect(bestMatch("sales_territory", columns, (c) => c)).toBeNull();
  });
});
