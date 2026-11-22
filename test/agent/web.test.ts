import { describe, expect, it } from "vitest";
import { leaksDatabaseValues, userTypedText } from "../../src/agent/web.js";
import { cleanPage, isUsablePage, selectRelevant } from "../../src/net/web-search.js";

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

describe("isUsablePage", () => {
  it("drops stubs and cookie or login walls", () => {
    expect(isUsablePage("120 posts")).toBe(false);
    expect(isUsablePage("Before you continue to YouTube. We use cookies to deliver Google services. ".repeat(4))).toBe(false);
  });

  it("keeps a long article that mentions cookies in its footer", () => {
    expect(isUsablePage("Real article text about churn benchmarks. ".repeat(60) + "We use cookies.")).toBe(true);
  });
});

describe("cleanPage", () => {
  it("leaves nothing usable of a consent page with a language picker, in any language", () => {
    const consent = ["de", "*   Deutsch", "*   English", "*   Español", "*   Français", "Anmelden", "![YouTube](https://www.gstatic.com/logo.svg)", "Ein Google-Unternehmen"]
      .concat(Array.from({ length: 80 }, (_, i) => `*   Sprache ${i}`.replace(/ \d+$/, "")))
      .join("\n");
    expect(isUsablePage(cleanPage(consent))).toBe(false);
  });

  it("rejects an adult-site age gate", () => {
    const gate = "ADULTS ONLY! The Website contains age-restricted materials. By clicking I AGREE below, you state that you are at least 18 years of age, have reached the age of majority in your jurisdiction. You will promptly leave this Website if explicit content offends you.";
    expect(isUsablePage(cleanPage(gate))).toBe(false);
  });

  it("keeps prose and dated list lines", () => {
    const page = ["*   Home", "*   Shorts", "New cinematic video part 2 · 3 days ago", "This channel posts weekly videos about travel and food."].join("\n");
    expect(cleanPage(page).split("\n")).toEqual([
      "New cinematic video part 2 · 3 days ago",
      "This channel posts weekly videos about travel and food.",
    ]);
  });
});

describe("selectRelevant", () => {
  it("prefers lines that mention the search terms over the first lines", () => {
    const filler = Array.from({ length: 100 }, (_, i) => `Unrelated paragraph number ${i} about nothing much at all.`);
    const text = [...filler, "Latest video: Cinematic Part 2, uploaded 2026-11-20."].join("\n");
    expect(selectRelevant(text, ["latest", "video"], 400)).toContain("Cinematic Part 2");
  });
});

