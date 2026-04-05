export class LLMJsonResponseException extends Error {
  constructor(message: string, public invalidContent: string, public llmName: string) {
    super(message);
    this.name = "LLMJsonResponseException";
    this.invalidContent = invalidContent;
    this.llmName = llmName;
  }
}