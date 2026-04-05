export class LLMTimeoutException extends Error {
  constructor(message: string, public llmName: string) {
    super(message);
    this.name = "LLMTimeoutException";
    this.llmName = llmName;
  }
}