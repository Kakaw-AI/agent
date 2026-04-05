import type { AgentStreamEvent } from "../types.js";

export class PipelineEmitter {
  private queue: AgentStreamEvent[] = [];
  private resolve: (() => void) | null = null;
  private done = false;

  emit(event: AgentStreamEvent): void {
    this.queue.push(event);
    if (this.resolve) {
      const res = this.resolve;
      this.resolve = null;
      res();
    }
  }

  finish(): void {
    this.done = true;
    if (this.resolve) {
      const res = this.resolve;
      this.resolve = null;
      res();
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<AgentStreamEvent> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) break;
      await new Promise<void>((res) => {
        this.resolve = res;
      });
    }
    while (this.queue.length > 0) {
      yield this.queue.shift()!;
    }
  }
}
