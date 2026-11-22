import { describe, expect, it } from "vitest";
import { cleanTitle } from "../../src/agent/title.js";

describe("cleanTitle", () => {
  it("strips quotes, a trailing full stop and extra spaces", () => {
    expect(cleanTitle('  "Top  customers by revenue."  ')).toBe("Top customers by revenue");
  });

  it("keeps non-Latin titles intact", () => {
    expect(cleanTitle("«أعلى المؤديات طلباً»")).toBe("أعلى المؤديات طلباً");
  });

  it("cuts a long title at a word boundary", () => {
    const title = cleanTitle("Monthly revenue by region and product category for the last three fiscal years");
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });

  it("returns empty for an empty answer", () => {
    expect(cleanTitle('  ""  ')).toBe("");
  });
});
