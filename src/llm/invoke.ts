import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { LLM_TIMEOUT_MS } from "../config.js";
import { LLMJsonResponseException } from "../exceptions/LLMJsonResponseException.js";
import { LLMTimeoutException } from "../exceptions/LLMTimeoutException.js";
import { DefaultJsonPromptBuilder } from "../prompts/BaseJsonFixPromptBuilder.js";
import type { TokenUsage } from "../types.js";
import { flattenContent } from "../utils/text.js";
import { mergeTokenUsage } from "../utils/token.js";
import { createLangChainModel, extractTokenUsage } from "./langchain.js";
import client from "./mcp.js";
import { toLangChainMessages } from "./messages.js";
import { invokeCopilot } from "./providers/copilot.js";
import {
  InvokeJsonResponse,
  InvokeResult,
  InvokeTextInput,
  LLMJsonInput,
} from "./types.js";

export async function invokeText(
  input: InvokeTextInput,
): Promise<InvokeResult> {
  if (input.llm.provider === "github-copilot") {
    return invokeCopilot({
      ...input,
      llm: input.llm,
    });
  }
const mcpTools = await client.getTools();
  const model = createLangChainModel(input.llm, input.temperature ?? 0.2);
  const timeoutMs = LLM_TIMEOUT_MS;
  const response = await Promise.race([
    model.invoke([
      new SystemMessage(input.systemPrompt),
      ...toLangChainMessages(input.history ?? []),
      new HumanMessage(input.userPrompt),
    ], {
      tools: mcpTools,
    }),
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
  return {
    content,
    tokenUsage: extractTokenUsage(response),
  };
}

export async function invokeJson<T>(
  input: LLMJsonInput,
): Promise<InvokeJsonResponse<T>> {
  const invoke = input.invokeTextFn ?? invokeText;
  const maxAttempts = 3;
  let tokenUsage: TokenUsage | null = null;
  let invalidJsonPreview = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const promptBuilder = new DefaultJsonPromptBuilder();
    const userPrompt = promptBuilder.build({
      userPrompt: input.userPrompt,
      attempt,
      invalidJsonPreview,
    });
    const result = await invoke({
      llm: input.llm,
      systemPrompt: input.systemPrompt,
      userPrompt,
      history: input.history,
      temperature: input.temperature,
    });
    tokenUsage = mergeTokenUsage(tokenUsage, result.tokenUsage);

    try {
      return {
        value: JSON.parse(result.content) as T,
        tokenUsage,
      };
    } catch {
      if (attempt === maxAttempts) {
        throw new LLMJsonResponseException(
          `LLM returned invalid JSON after ${maxAttempts} attempts`,
          result.content,
          input.llm.provider,
        );
      }
    }
  }

  throw new LLMJsonResponseException(
    "LLM returned invalid JSON",
    invalidJsonPreview,
    input.llm.provider,
  );
}
