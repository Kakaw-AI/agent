import { ChatAnthropic } from "@langchain/anthropic";
import {
  AIMessage
} from "@langchain/core/messages";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import type {
  TokenUsage
} from "../types.js";
import { LLMRuntime } from "./types.js";

export function createLangChainModel(
  llm: LLMRuntime,
  temperature: number,
): ChatOpenAI | ChatAnthropic | ChatGoogleGenerativeAI {
  switch (llm.provider) {
    case "openai":
    case "openrouter":
    case "ollama":
    case "lm-studio":
      return new ChatOpenAI({
        model: llm.model,
        apiKey: llm.apiKey || "empty",
        temperature,
        configuration: {
          baseURL:
            llm.provider === "openrouter"
              ? "https://openrouter.ai/api/v1"
              : llm.baseUrl,
          defaultHeaders: llm.headers,
        },
      });
    case "anthropic":
      return new ChatAnthropic({
        model: llm.model,
        apiKey: llm.apiKey,
        temperature,
      });
    case "google":
      return new ChatGoogleGenerativeAI({
        model: llm.model,
        apiKey: llm.apiKey,
        temperature,
      });
  }
}


export function extractTokenUsage(response: AIMessage): TokenUsage | null {
  const usage = response.usage_metadata;
  if (!usage) {
    return null;
  }

  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    totalTokens: usage.total_tokens ?? 0,
  };
}
