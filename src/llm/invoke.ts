import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { AgentHistoryMessage, AgentLlmRuntime, TokenUsage } from "../types.js";
import { invokeCopilot } from "./copilot.js";
import { createLangChainModel, extractTokenUsage, flattenContent, toLangChainMessages } from "./langchain.js";

export type InvokeResult = {
  content: string;
  tokenUsage: TokenUsage | null;
};

export async function invokeText(input: {
  llm: AgentLlmRuntime;
  systemPrompt: string;
  userPrompt: string;
  history?: AgentHistoryMessage[];
  temperature?: number;
}): Promise<InvokeResult> {
  if (input.llm.provider === "github-copilot") {
    return invokeCopilot({
      ...input,
      llm: input.llm,
    });
  }

  const model = createLangChainModel(input.llm, input.temperature ?? 0.2);
  const timeoutMs = 30_000;
  const response = await Promise.race([
    model.invoke([
      new SystemMessage(input.systemPrompt),
      ...toLangChainMessages(input.history ?? []),
      new HumanMessage(input.userPrompt),
    ]),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`LLM call timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);

  const content = flattenContent(response.content);
  return {
    content,
    tokenUsage: extractTokenUsage(response),
  };
}

export async function invokeJson<T>(input: {
  llm: AgentLlmRuntime;
  systemPrompt: string;
  userPrompt: string;
  history?: AgentHistoryMessage[];
  temperature?: number;
}): Promise<{ value: T; tokenUsage: TokenUsage | null }> {
  const result = await invokeText({
    ...input,
    userPrompt: `${input.userPrompt}\n\nReturn only valid JSON. Do not wrap it in markdown.`,
  });

  let parsed: T;
  try {
    parsed = JSON.parse(result.content) as T;
  } catch {
    throw new Error(`LLM returned invalid JSON: ${result.content.slice(0, 200)}`);
  }

  return {
    value: parsed,
    tokenUsage: result.tokenUsage,
  };
}
