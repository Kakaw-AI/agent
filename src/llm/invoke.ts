import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  type AIMessageChunk,
  HumanMessage,
} from "@langchain/core/messages";
import { LLM_TIMEOUT_MS } from "../config.js";
import { LLMTimeoutException } from "../exceptions/LLMTimeoutException.js";
import type { TokenUsage } from "../types.js";
import { flattenContent, flattenContentRaw } from "../utils/text.js";
import {
  buildSystemMessage,
  createLangChainModel,
  extractTokenUsage,
} from "./langchain.js";
import client from "./mcp.js";
import { toLangChainMessages } from "./messages.js";
import type {
  InvokeJsonResponse,
  InvokeResult,
  InvokeTextInput,
  InvokeTextStreamInput,
  LLMJsonInput,
} from "./types.js";

export async function invokeText(
  input: InvokeTextInput,
): Promise<InvokeResult> {
  const model = input.llm.model;
  const temperature = input.temperature ?? 0.2;

  input.onLlmCall?.({
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    model,
    temperature,
  });

  const mcpTools = await client.getTools();
  const langchainModel = createLangChainModel(input.llm, temperature);
  const timeoutMs = LLM_TIMEOUT_MS;

  const response = await Promise.race([
    langchainModel.invoke(
      [
        buildSystemMessage(input.llm.provider, input.systemPrompt),
        ...toLangChainMessages(input.history ?? []),
        new HumanMessage(input.userPrompt),
      ],
      {
        tools: mcpTools,
      },
    ),
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            new LLMTimeoutException(
              `LLM call timed out after ${timeoutMs}ms`,
              input.llm.provider,
            ),
          ),
        timeoutMs,
      ),
    ),
  ]);

  const content = flattenContent(response.content);
  const result: InvokeResult = {
    content,
    tokenUsage: extractTokenUsage(response),
  };

  input.onLlmResponse?.(result);
  return result;
}

/**
 * Streaming counterpart to `invokeText`.
 *
 * The answer is the only user-visible text the pipeline produces, so streaming
 * it is what turns "wait for the whole run, then see everything" into "watch it
 * being written". The timeout guards time-to-first-chunk rather than the whole
 * stream: once tokens are flowing the call is demonstrably alive, and a long
 * answer must not be killed for being long.
 */
export async function invokeTextStream(
  input: InvokeTextStreamInput,
): Promise<InvokeResult> {
  const model = input.llm.model;
  const temperature = input.temperature ?? 0.2;

  input.onLlmCall?.({
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    model,
    temperature,
  });

  const langchainModel = createLangChainModel(input.llm, temperature);

  const stream = await withTimeout(
    langchainModel.stream([
      buildSystemMessage(input.llm.provider, input.systemPrompt),
      ...toLangChainMessages(input.history ?? []),
      new HumanMessage(input.userPrompt),
    ]),
    LLM_TIMEOUT_MS,
    input.llm.provider,
  );

  let content = "";
  let tokenUsage: TokenUsage | null = null;
  let aggregate: AIMessageChunk | null = null;

  for await (const chunk of stream) {
    aggregate = aggregate ? aggregate.concat(chunk) : chunk;

    // Raw, not trimmed: a per-chunk trim would eat the spaces between words.
    const delta = flattenContentRaw(chunk.content);
    if (delta) {
      content += delta;
      input.onDelta(delta);
    }
  }

  if (aggregate) {
    tokenUsage = extractTokenUsage(aggregate as unknown as AIMessage);
  }

  const result: InvokeResult = { content: content.trim(), tokenUsage };
  input.onLlmResponse?.(result);
  return result;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  provider: string,
): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new LLMTimeoutException(
              `LLM call timed out after ${timeoutMs}ms`,
              provider,
            ),
          ),
        timeoutMs,
      );
    }),
  ]);
}

export async function invokeJson<T>(
  input: LLMJsonInput<T>,
): Promise<InvokeJsonResponse<T>> {
  const temperature = input.temperature ?? 0.2;

  input.onLlmCall?.({
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    model: input.llm.model,
    temperature,
  });

  const langchainModel = createLangChainModel(input.llm, temperature);

  // Cast to the base type for this call: the concrete Chat* classes declare
  // mutually-incompatible `withStructuredOutput` overloads, so calling it on
  // their union fails to type-check (TS2349). The base type exposes a single
  // compatible signature and the method exists on every provider at runtime.
  const structured = (langchainModel as BaseChatModel).withStructuredOutput(
    input.schema,
    { includeRaw: true },
  );

  // invokeJson drives five of the six LLM call sites and previously had no
  // timeout at all, so a hung provider call hung the whole request.
  const { raw, parsed } = (await withTimeout(
    structured.invoke([
      buildSystemMessage(input.llm.provider, input.systemPrompt),
      ...toLangChainMessages(input.history ?? []),
      new HumanMessage(input.userPrompt),
    ]),
    LLM_TIMEOUT_MS,
    input.llm.provider,
  )) as { raw: AIMessage; parsed: T };

  const tokenUsage: TokenUsage | null = extractTokenUsage(raw);

  input.onLlmResponse?.({
    content: JSON.stringify(parsed),
    tokenUsage,
  });

  return { value: parsed, tokenUsage };
}
