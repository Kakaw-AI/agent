import type { AgentHistoryMessage, AgentLlmRuntime, TokenUsage } from "../types.js";

export type LlmCallHook = (input: {
  systemPrompt: string;
  userPrompt: string;
  model: string;
  temperature: number;
}) => void;

export type LlmResponseHook = (result: {
  content: string;
  tokenUsage: TokenUsage | null;
}) => void;

export type LLMRuntime = AgentLlmRuntime;

export type InvokeResult = {
  content: string;
  tokenUsage: TokenUsage | null;
};

export type LlmCall = {
  llm: AgentLlmRuntime;
  systemPrompt: string;
  userPrompt: string;
  history?: AgentHistoryMessage[];
  temperature?: number;
  /** Aborts the provider request, e.g. when the client disconnects. */
  signal?: AbortSignal;
  /** Upper bound on the reply; generous, since reasoning models count their thinking. */
  maxTokens?: number;
  onLlmCall?: LlmCallHook;
  onLlmResponse?: LlmResponseHook;
};
