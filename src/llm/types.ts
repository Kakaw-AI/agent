import { AgentHistoryMessage, AgentLlmRuntime, TokenUsage } from "../types.js";

// --- new hook types ---
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
// ---------------------

type LLMMessage = {
    message?: {
        content?: string;
    };
};

type LLMUsage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
};

export interface CopilotResponse {
    choices?: Array<LLMMessage>;
    usage?: LLMUsage;
}

export interface LLMInput {
  llm: Extract<AgentLlmRuntime, {
    provider: "github-copilot";
  }>;
  systemPrompt: string;
  userPrompt: string;
  history?: AgentHistoryMessage[];
  temperature?: number;
}


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
  onLlmCall?: LlmCallHook;       // new
  onLlmResponse?: LlmResponseHook; // new
};


export type LLMRuntime = Extract<AgentLlmRuntime, {
  provider: "openai" | "custom-openai" | "openrouter" | "anthropic" | "google";
}>;


export type LLMJsonInput = InvokeTextInput & {
  invokeTextFn?: (input: InvokeTextInput) => Promise<InvokeResult>;
};

export interface InvokeJsonResponse  <T> {
  value: T;
  tokenUsage: TokenUsage | null;
}
