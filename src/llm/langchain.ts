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

type ChatModel = ChatOpenAI | ChatAnthropic | ChatGoogleGenerativeAI;

// A client was constructed for every LLM call — up to eight per request. The
// clients are stateless with respect to the messages they send, so one per
// (provider, model, temperature, endpoint) is enough. Keyed on the API key too,
// since a single process serves multiple users' connections.
const MODEL_CACHE_MAX = 16;
const modelCache = new Map<string, ChatModel>();

function modelCacheKey(llm: LLMRuntime, temperature: number, maxTokens: number | undefined, lowThinking: boolean): string {
  return [
    llm.provider,
    llm.model,
    temperature,
    maxTokens ?? "",
    lowThinking ? "low" : "",
    llm.baseUrl ?? "",
    llm.apiKey ?? "",
  ].join("\0");
}

/**
 * Provider options that keep a reasoning model's hidden thinking short.
 *
 * Traces showed thinking was most of the latency: ~930 hidden tokens per call
 * against ~70 visible, up to 6,400 on one SQL draft (45 s). Only models known to
 * take the option get it; the rest would reject an unknown parameter.
 * Anthropic thinks only when asked to, so it needs nothing; local models get
 * "/no_think" in the prompt instead (invoke.ts).
 */
export function lowThinkingOptions(llm: LLMRuntime): Record<string, unknown> {
  const model = llm.model.toLowerCase().replace(/^models\//, "");
  switch (llm.provider) {
    case "google":
      // 2.5 takes a token budget (Pro cannot go below 128); 3 and later take a level.
      if (model.startsWith("gemini-2.5")) return { thinkingConfig: { thinkingBudget: model.includes("pro") ? 128 : 0 } };
      if (/^gemini-([3-9]|\d{2})/.test(model)) return { thinkingConfig: { thinkingLevel: "LOW" } };
      return {};
    case "openai":
      return /^(o\d|gpt-([5-9]|\d{2}))/.test(model) && !model.includes("-chat") ? { reasoningEffort: "low" } : {};
    case "openrouter":
      // OpenRouter maps this onto each provider and ignores it for models that do not reason.
      return { modelKwargs: { reasoning: { effort: "low" } } };
    default:
      return {};
  }
}

/**
 * No reply cap by default: a low one cut off long SQL replies mid-JSON. The
 * timeout still stops a looping model. Anthropic is the exception, its API
 * requires `max_tokens`, so it gets the largest value every current model takes.
 */
export function createLangChainModel(
  llm: LLMRuntime,
  temperature: number,
  maxTokens?: number,
  lowThinking = false,
): ChatModel {
  const key = modelCacheKey(llm, temperature, maxTokens, lowThinking);
  const cached = modelCache.get(key);
  if (cached) {
    modelCache.delete(key);
    modelCache.set(key, cached);
    return cached;
  }

  const model = buildLangChainModel(llm, temperature, maxTokens, lowThinking ? lowThinkingOptions(llm) : {});
  modelCache.set(key, model);

  while (modelCache.size > MODEL_CACHE_MAX) {
    const oldest = modelCache.keys().next();
    if (oldest.done) {
      break;
    }
    modelCache.delete(oldest.value);
  }

  return model;
}

function buildLangChainModel(
  llm: LLMRuntime,
  temperature: number,
  maxTokens: number | undefined,
  thinking: Record<string, unknown>,
): ChatModel {
  switch (llm.provider) {
    case "openai":
    case "openrouter":
    case "ollama":
    case "lm-studio":
      return new ChatOpenAI({
        model: llm.model,
        apiKey: llm.apiKey || "empty",
        temperature,
        ...(maxTokens ? { maxTokens } : {}),
        ...thinking,
        configuration: {
          baseURL:
            llm.provider === "openrouter"
              ? "https://openrouter.ai/api/v1"
              : llm.baseUrl,
          defaultHeaders: llm.headers,
          // The base URL can be user-supplied and is checked against private
          // addresses before the run. A redirect would walk past that check.
          fetch: (url, init) => fetch(url, { ...init, redirect: "error" }),
        },
      });
    case "anthropic":
      return new ChatAnthropic({
        model: llm.model,
        apiKey: llm.apiKey,
        temperature,
        maxTokens: maxTokens ?? 64000,
      });
    case "google":
      return new ChatGoogleGenerativeAI({
        model: llm.model,
        apiKey: llm.apiKey,
        temperature,
        ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
        ...thinking,
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

  // Providers report cache hits in a nested `input_token_details` block that
  // LangChain passes through unchanged.
  const details = usage.input_token_details as
    | { cache_read?: number; cache_creation?: number }
    | undefined;

  // Gemini leaves thinking out of output_tokens but counts it in the total, and
  // bills it as output. OpenAI already includes it in output_tokens. Folding
  // the gap into output makes both report what the call cost.
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const hidden = Math.max(0, (usage.total_tokens ?? 0) - input - output);
  const reasoning = (usage.output_token_details as { reasoning?: number } | undefined)?.reasoning ?? hidden;

  return {
    inputTokens: input,
    outputTokens: output + hidden,
    totalTokens: usage.total_tokens ?? input + output,
    reasoningTokens: reasoning,
    cacheReadTokens: details?.cache_read ?? 0,
    cacheWriteTokens: details?.cache_creation ?? 0,
  };
}
