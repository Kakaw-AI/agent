export class LLMResponseException extends Error {
  constructor(message: string, public statusCode: number, public llmName: string) {
    super(message);
    this.name = "LLMResponseException";
    this.statusCode = statusCode;
    this.llmName = llmName;

  }
}