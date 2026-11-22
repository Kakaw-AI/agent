import { describe, expect, it } from "vitest";
import { leaksDatabaseValues, userTypedText } from "../../src/agent/web.js";

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

describe("userTypedText", () => {
  it("includes earlier user turns, so a name typed before can be searched in a follow-up", () => {
    const text = userTypedText({
      message: "what is her latest video online?",
      history: [
        { role: "user", content: "who is Acme Corp" },
        { role: "assistant", content: "Acme Corp is a customer since 2021." },
      ],
    } as never);
    expect(leaksDatabaseValues("Acme Corp latest video", text, new Set(["acme corp"]))).toBe(false);
    expect(text).not.toContain("customer since");
  });
});
