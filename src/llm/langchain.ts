import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
import type { AgentHistoryMessage, AgentLlmRuntime, TokenUsage } from "../types.js";

export function createLangChainModel(
  llm: Extract<AgentLlmRuntime, { provider: "openai" | "custom-openai" | "openrouter" | "anthropic" | "google" }>,
  temperature: number,
) {
  switch (llm.provider) {
    case "openai":
    case "custom-openai":
    case "openrouter":
      return new ChatOpenAI({
        model: llm.model,
        apiKey: llm.apiKey,
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

export function toLangChainMessages(history: AgentHistoryMessage[]) {
  return history.map((message) => {
    switch (message.role) {
      case "assistant":
        return new AIMessage(message.content);
      case "system":
        return new SystemMessage(message.content);
      default:
        return new HumanMessage(message.content);
    }
  });
}

export function flattenContent(content: unknown) {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "",
      )
      .join("")
      .trim();
  }

  return "";
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
