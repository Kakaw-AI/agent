import { describe, it, expect, vi } from "vitest";
import { AgentPipeline } from "../../src/pipeline/AgentPipeline.js";
import { AgentLayer, EdgeBuilder, LayerMap } from "../../src/pipeline/AgentLayer.js";
import type { GraphStateValue } from "../../src/graph/state.js";
import type { AgentRunRequest } from "../../src/types.js";

// Minimal layer stub
function makeLayer(name: string, result: Partial<GraphStateValue> = {}): AgentLayer {
  return new (class extends AgentLayer {
    readonly name = name;
    async execute(_req: AgentRunRequest, _state: GraphStateValue) {
      return result;
    }
  })();
}

describe("AgentPipeline", () => {
  it("can register layers via use() and returns pipeline instance (chaining)", () => {
    const pipeline = new AgentPipeline();
    const result = pipeline.use(makeLayer("a")).use(makeLayer("b"));
    expect(result).toBe(pipeline);
  });

  it("shouldSkip wrapping: skips execute when shouldSkip returns true", async () => {
    const executeSpy = vi.fn().mockResolvedValue({ answer: "hello" });
    const layer = new (class extends AgentLayer {
      readonly name = "skippable";
      shouldSkip() { return true; }
      async execute(req: AgentRunRequest, state: GraphStateValue) {
        return executeSpy(req, state);
      }
    })();

    // Access the internal node handler directly
    const pipeline = new AgentPipeline();
    pipeline.use(layer);
    const handler = (pipeline as any).buildNodeHandler(layer);
    const result = await handler({} as any);
    expect(executeSpy).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it("shouldSkip wrapping: calls execute when shouldSkip returns false", async () => {
    const executeSpy = vi.fn().mockResolvedValue({ answer: "done" });
    const layer = new (class extends AgentLayer {
      readonly name = "active";
      shouldSkip() { return false; }
      async execute(req: AgentRunRequest, state: GraphStateValue) {
        return executeSpy(req, state);
      }
    })();

    const pipeline = new AgentPipeline();
    pipeline.use(layer);
    const handler = (pipeline as any).buildNodeHandler(layer, {} as AgentRunRequest);
    await handler({} as any);
    expect(executeSpy).toHaveBeenCalledOnce();
  });
});
