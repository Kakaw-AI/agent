import {
  AIMessage,
  HumanMessage,
} from "@langchain/core/messages";
import { LLM_TIMEOUT_MS } from "../config.js";
import { LLMTimeoutException } from "../exceptions/LLMTimeoutException.js";
import type { TokenUsage } from "../types.js";
import { flattenContent } from "../utils/text.js";
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

  const structured = langchainModel.withStructuredOutput(input.schema, {
    includeRaw: true,
  });

  const { raw, parsed } = (await structured.invoke([
    buildSystemMessage(input.llm.provider, input.systemPrompt),
    ...toLangChainMessages(input.history ?? []),
    new HumanMessage(input.userPrompt),
  ])) as { raw: AIMessage; parsed: T };

  const tokenUsage: TokenUsage | null = extractTokenUsage(raw);

  input.onLlmResponse?.({
    content: JSON.stringify(parsed),
    tokenUsage,
  });

  return { value: parsed, tokenUsage };
}
