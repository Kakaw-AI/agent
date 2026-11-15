import { AIMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { extractTokenUsage, lowThinkingOptions } from "../../src/llm/langchain.js";
import type { LLMRuntime } from "../../src/llm/types.js";

const llm = (provider: LLMRuntime["provider"], model: string): LLMRuntime => ({ connectionId: "c", provider, model, apiKey: "k" });

describe("lowThinkingOptions", () => {
  it("only sends options a model accepts", () => {
    expect(lowThinkingOptions(llm("google", "gemini-3.8-flash"))).toEqual({ thinkingConfig: { thinkingLevel: "LOW" } });
    expect(lowThinkingOptions(llm("google", "gemini-2.5-flash"))).toEqual({ thinkingConfig: { thinkingBudget: 0 } });
    expect(lowThinkingOptions(llm("google", "gemini-2.5-pro"))).toEqual({ thinkingConfig: { thinkingBudget: 128 } });
    expect(lowThinkingOptions(llm("google", "gemini-2.0-flash"))).toEqual({});
    expect(lowThinkingOptions(llm("openai", "gpt-5-mini"))).toEqual({ reasoningEffort: "low" });
    expect(lowThinkingOptions(llm("openai", "gpt-4o"))).toEqual({});
    expect(lowThinkingOptions(llm("openai", "gpt-5-chat-latest"))).toEqual({});
    expect(lowThinkingOptions(llm("anthropic", "claude-sonnet-5-5"))).toEqual({});
    expect(lowThinkingOptions(llm("lm-studio", "qwen3-9b"))).toEqual({});
  });
});

describe("extractTokenUsage", () => {
  it("counts Gemini's hidden thinking as output", () => {
    // From a real trace: 8394 in, 154 visible out, 12476 total.
    const message = new AIMessage({ content: "", usage_metadata: { input_tokens: 8394, output_tokens: 154, total_tokens: 12476 } });
    expect(extractTokenUsage(message)).toMatchObject({ outputTokens: 4082, reasoningTokens: 3928, totalTokens: 12476 });
  });

  it("does not double count OpenAI, which already includes reasoning in output", () => {
    const message = new AIMessage({
      content: "",
      usage_metadata: { input_tokens: 100, output_tokens: 50, total_tokens: 150, output_token_details: { reasoning: 30 } },
    });
    expect(extractTokenUsage(message)).toMatchObject({ outputTokens: 50, reasoningTokens: 30 });
  });
});
