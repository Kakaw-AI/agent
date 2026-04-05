import type { JsonPromptBuildInput } from "./types.js";

abstract class BaseJsonPromptBuilder {
    protected abstract buildInitialPrompt(userPrompt: string): string;
    protected abstract buildRetryPrompt(
        userPrompt: string,
        invalidJsonPreview: string,
    ): string;

    build({ userPrompt, attempt, invalidJsonPreview }: JsonPromptBuildInput): string {
        const isFirstAttempt = attempt === 1;

        if (isFirstAttempt) {
            return this.buildInitialPrompt(userPrompt);
        }

        return this.buildRetryPrompt(userPrompt, invalidJsonPreview);
    }
}

export class DefaultJsonPromptBuilder extends BaseJsonPromptBuilder {
    private static readonly INITIAL_INSTRUCTION =
        "Return only valid JSON. Do not wrap it in markdown.";

    private static readonly RETRY_INSTRUCTIONS = [
        "Your previous response was invalid JSON.",
        "Return only corrected valid JSON. Do not include markdown, commentary, or trailing text.",
        
    ] as const;

    protected buildInitialPrompt(userPrompt: string): string {
        return [userPrompt, "", DefaultJsonPromptBuilder.INITIAL_INSTRUCTION].join(
            "\n",
        );
    }

    protected buildRetryPrompt(
        userPrompt: string,
        invalidJsonPreview: string,
    ): string {
        return [
            userPrompt,
            "",
            DefaultJsonPromptBuilder.RETRY_INSTRUCTIONS[0],
            `Previous invalid response: ${invalidJsonPreview}`,
            DefaultJsonPromptBuilder.RETRY_INSTRUCTIONS[1],
        ].join("\n");
    }
}
