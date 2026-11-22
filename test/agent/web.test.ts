import { describe, expect, it } from "vitest";
import { leaksDatabaseValues } from "../../src/agent/web.js";

describe("leaksDatabaseValues", () => {
  const values = new Set(["acme corp", "jane.doe@example.com", "asia pacific"]);

  it("flags a query carrying a database value the user did not type", () => {
    expect(leaksDatabaseValues("Acme Corp revenue 2026", "how does our top customer compare?", values)).toBe(true);
    expect(leaksDatabaseValues("jane.doe@example.com", "who is this?", values)).toBe(true);
  });

  it("allows a value the user wrote themselves", () => {
    expect(leaksDatabaseValues("Asia Pacific SaaS market size", "how big is the Asia Pacific market?", values)).toBe(false);
  });

  it("allows a generic query", () => {
    expect(leaksDatabaseValues("average SaaS churn rate 2026", "is our churn high?", values)).toBe(false);
  });
});
