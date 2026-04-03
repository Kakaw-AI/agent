import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { ChatAnthropic } from "@langchain/anthropic";
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { ChatOpenAI } from "@langchain/openai";
export async function invokeText(input) {
    if (input.llm.provider === "github-copilot") {
        return invokeCopilot({
            ...input,
            llm: input.llm,
        });
    }
    const model = createLangChainModel(input.llm, input.temperature ?? 0.2);
    const response = await model.invoke([
        new SystemMessage(input.systemPrompt),
        ...toLangChainMessages(input.history ?? []),
        new HumanMessage(input.userPrompt),
    ]);
    const content = flattenContent(response.content);
    return {
        content,
        tokenUsage: extractTokenUsage(response),
    };
}
export async function invokeJson(input) {
    const result = await invokeText({
        ...input,
        userPrompt: `${input.userPrompt}\n\nReturn only valid JSON. Do not wrap it in markdown.`,
    });
    return {
        value: JSON.parse(result.content),
        tokenUsage: result.tokenUsage,
    };
}
function createLangChainModel(llm, temperature) {
    switch (llm.provider) {
        case "openai":
        case "custom-openai":
        case "openrouter":
            return new ChatOpenAI({
                model: llm.model,
                apiKey: llm.apiKey,
                temperature,
                configuration: {
                    baseURL: llm.provider === "openrouter"
                        ? "https://openrouter.ai/api/v1"
                        : llm.baseUrl,
                    defaultHeaders: llm.headers,
                },
            });
        case "anthropic":
            return new ChatAnthropic({
                model: llm.model,
                apiKey: llm.apiKey,
                temperature,
            });
        case "google":
            return new ChatGoogleGenerativeAI({
                model: llm.model,
                apiKey: llm.apiKey,
                temperature,
            });
    }
}
async function invokeCopilot(input) {
    const messages = [
        { role: "system", content: input.systemPrompt },
        ...toRawMessages(input.history ?? []),
        { role: "user", content: input.userPrompt },
    ];
    const response = await fetch("https://models.github.ai/inference/chat/completions", {
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
    });
    if (!response.ok) {
        throw new Error(await response.text());
    }
    const payload = (await response.json());
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
function toLangChainMessages(history) {
    return history.map((message) => {
        switch (message.role) {
            case "assistant":
                return new AIMessage(message.content);
            case "system":
                return new SystemMessage(message.content);
            default:
                return new HumanMessage(message.content);
        }
    });
}
function toRawMessages(history) {
    return history.map((message) => ({
        role: message.role,
        content: message.content,
    }));
}
function flattenContent(content) {
    if (typeof content === "string") {
        return content.trim();
    }
    if (Array.isArray(content)) {
        return content
            .map((part) => part && typeof part === "object" && "text" in part ? String(part.text ?? "") : "")
            .join("")
            .trim();
    }
    return "";
}
function extractTokenUsage(response) {
    const usage = response.usage_metadata;
    if (!usage) {
        return null;
    }
    return {
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        totalTokens: usage.total_tokens ?? 0,
    };
}
