import type { ZodType } from "zod";
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

export type InvokeTextInput = {
  llm: AgentLlmRuntime;
  systemPrompt: string;
  userPrompt: string;
  history?: AgentHistoryMessage[];
  temperature?: number;
  onLlmCall?: LlmCallHook;
  onLlmResponse?: LlmResponseHook;
};

export type InvokeTextStreamInput = InvokeTextInput & {
  /** Called for every non-empty chunk as it arrives. */
  onDelta: (delta: string) => void;
};

export type LLMJsonInput<T> = {
  llm: AgentLlmRuntime;
  systemPrompt: string;
  userPrompt: string;
  history?: AgentHistoryMessage[];
  temperature?: number;
  onLlmCall?: LlmCallHook;
  onLlmResponse?: LlmResponseHook;
  schema: ZodType<T>;
};

export interface InvokeJsonResponse<T> {
  value: T;
  tokenUsage: TokenUsage | null;
}
