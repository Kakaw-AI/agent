
import { LLMResponseException } from "../../exceptions/LLMResponseException.js";
import { LLMTimeoutException } from "../../exceptions/LLMTimeoutException.js";
import { toRawMessages } from "../messages.js";
import { CopilotResponse, InvokeResult, LLMInput } from "../types.js";


export async function invokeCopilot(input: LLMInput): Promise<InvokeResult> {
  const messages = [
    { role: "system", content: input.systemPrompt },
    ...toRawMessages(input.history ?? []),
    { role: "user", content: input.userPrompt },
  ];

  const copilotBaseUrl =
    process.env.GITHUB_COPILOT_BASE_URL ?? "https://models.github.ai/inference";

  const timeoutMs = 30_000;
  const response = await Promise.race([
    fetch(`${copilotBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${input.llm.accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: input.llm.model,
        messages,
        temperature: input.temperature ?? 0.2,
      }),
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new LLMTimeoutException(`LLM call timed out after ${timeoutMs}ms`, input.llm.provider)), timeoutMs),
    ),
  ]);

  if (!response.ok) {
    throw new LLMResponseException(await response.text(), response.status, "github-copilot");
  }

  

  const payload = (await response.json()) as CopilotResponse;

  return {
    content: payload.choices?.[0]?.message?.content?.trim() ?? "",
    tokenUsage: payload.usage
      ? {
          inputTokens: payload.usage.prompt_tokens ?? 0,
          outputTokens: payload.usage.completion_tokens ?? 0,
          totalTokens: payload.usage.total_tokens ?? 0,
        }
      : null,
  };
}
