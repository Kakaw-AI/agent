import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { AIMessage, type AIMessageChunk, HumanMessage } from "@langchain/core/messages";
import type { ZodType } from "zod";
import { LLM_TIMEOUT_MS, LOCAL_LLM_TIMEOUT_MS } from "../config.js";
import { LLMTimeoutException } from "../exceptions/LLMTimeoutException.js";
import type { TokenUsage } from "../types.js";
import { flattenContentRaw } from "../utils/text.js";
import { buildSystemMessage, createLangChainModel, extractTokenUsage } from "./langchain.js";
import { toLangChainMessages } from "./messages.js";
import type { InvokeResult, LlmCall } from "./types.js";

const isLocal = (llm: LlmCall["llm"]) => llm.provider === "ollama" || llm.provider === "lm-studio";
const timeoutMs = (llm: LlmCall["llm"]) => (isLocal(llm) ? LOCAL_LLM_TIMEOUT_MS : LLM_TIMEOUT_MS);

const lowThinking = (input: LlmCall) => Boolean(input.light || input.llm.disableThinking);

function model(input: LlmCall, temperature: number) {
  return createLangChainModel(input.llm, temperature, input.maxTokens, lowThinking(input));
}

/** Failed calls still cost tokens; callers read this to keep the run's total honest. */
export class LlmReplyError extends Error {
  constructor(message: string, readonly tokenUsage: TokenUsage | null) {
    super(message);
  }
}

function toMessages(input: LlmCall) {
  // "/no_think" is the Qwen-family soft switch that LM Studio and Ollama pass through.
  const suffix = lowThinking(input) && isLocal(input.llm) ? " /no_think" : "";
  return [
    buildSystemMessage(input.llm.provider, input.systemPrompt),
    ...toLangChainMessages(input.history ?? []),
    new HumanMessage(input.userPrompt + suffix),
  ];
}

function timeoutError(llm: LlmCall["llm"]) {
  return new LLMTimeoutException(`LLM call timed out after ${timeoutMs(llm)}ms`, llm.provider);
}

/**
 * A model call returning data that matches `schema`.
 *
 * The timeout aborts the HTTP request rather than racing it, so a slow
 * provider stops costing tokens when we give up on it; the run's own signal
 * (client disconnect, shutdown) aborts it the same way.
 */
export async function invokeStructured<T>(
  input: LlmCall & { schema: ZodType<T> },
): Promise<{ value: T; tokenUsage: TokenUsage | null }> {
  const temperature = input.temperature ?? 0.2;
  input.onLlmCall?.({
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    model: input.llm.model,
    temperature,
  });

  // Cast to the base type: the concrete Chat* classes declare incompatible
  // `withStructuredOutput` overloads, so calling it on their union does not
  // type-check. The method exists on every provider.
  const structured = (model(input, temperature) as BaseChatModel).withStructuredOutput(
    input.schema,
    { includeRaw: true },
  );

  const timeout = AbortSignal.timeout(timeoutMs(input.llm));
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;

  let response: { raw: AIMessage; parsed: T | null };
  try {
    response = (await structured.invoke(toMessages(input), { signal, runName: input.name })) as typeof response;
  } catch (error) {
    if (timeout.aborted) throw timeoutError(input.llm);
    throw error;
  }

  const tokenUsage = extractTokenUsage(response.raw);
  input.onLlmResponse?.({ content: JSON.stringify(response.parsed), tokenUsage });
  // With includeRaw a reply that does not fit the schema comes back as null
  // instead of throwing; treat it as the failure it is.
  if (response.parsed === null || response.parsed === undefined) {
    // The raw reply is the only clue to why parsing failed (prose, empty, a
    // tool call with bad args); keep a short copy in the error for traces/logs.
    const full = flattenContentRaw(response.raw.content).trim();
    const raw = full.slice(0, 300);
    const calls = JSON.stringify(response.raw.tool_calls ?? []).slice(0, 300);
    let why = "not valid JSON (cut off or prose)";
    try {
      const check = input.schema.safeParse(JSON.parse(full));
      if (!check.success) why = check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    } catch {
      // keep the default reason
    }
    console.warn(`[llm] unparsable structured reply from ${input.llm.model}: why=${why} length=${full.length} tail=${JSON.stringify(full.slice(-200))} tool_calls=${calls}`);
    throw new LlmReplyError(`The model's reply did not match the expected format (${why}). Got: ${raw || calls}`, tokenUsage);
  }
  return { value: response.parsed, tokenUsage };
}

/**
 * Streaming text call. The timeout covers time to the first chunk: once tokens
 * are flowing the call is alive, and a long answer must not be cut off for
 * being long.
 */
export async function invokeStream(
  input: LlmCall & { onDelta: (delta: string) => void },
): Promise<InvokeResult> {
  const temperature = input.temperature ?? 0.2;
  input.onLlmCall?.({
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    model: input.llm.model,
    temperature,
  });

  const firstChunk = new AbortController();
  const timer = setTimeout(() => firstChunk.abort(), timeoutMs(input.llm));
  const signal = input.signal ? AbortSignal.any([input.signal, firstChunk.signal]) : firstChunk.signal;

  let content = "";
  let aggregate: AIMessageChunk | null = null;
  try {
    const stream = await model(input, temperature).stream(toMessages(input), { signal, runName: input.name });
    for await (const chunk of stream) {
      clearTimeout(timer);
      aggregate = aggregate ? aggregate.concat(chunk) : chunk;
      // Raw, not trimmed: a per-chunk trim would eat the spaces between words.
      const delta = flattenContentRaw(chunk.content);
      if (delta) {
        content += delta;
        input.onDelta(delta);
      }
    }
  } catch (error) {
    if (firstChunk.signal.aborted) throw timeoutError(input.llm);
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const result: InvokeResult = {
    content: content.trim(),
    tokenUsage: aggregate ? extractTokenUsage(aggregate as unknown as AIMessage) : null,
  };
  input.onLlmResponse?.(result);
  return result;
}
