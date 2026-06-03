import { ChatAnthropic } from "@langchain/anthropic";
import {
  AIMessage,
  SystemMessage
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


/**
 * Builds the system message for an LLM call. For Anthropic the large, static
 * system prompt (dialect rules + full schema catalog) is emitted as a single
 * cache-controlled content block so repeated calls on the same schema (repair
 * loops, follow-up questions) hit Anthropic's prompt cache instead of re-paying
 * for the whole prefix. OpenAI/OpenRouter cache a stable prefix automatically,
 * so a plain string suffices there.
 */
export function buildSystemMessage(
  provider: LLMRuntime["provider"],
  systemPrompt: string,
): SystemMessage {
  if (provider === "anthropic") {
    return new SystemMessage({
      content: [
        {
          type: "text",
          text: systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ],
    });
  }

  return new SystemMessage(systemPrompt);
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
