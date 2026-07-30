import { beforeEach, describe, expect, it, vi } from "vitest";
import { AIMessageChunk } from "@langchain/core/messages";

const stream = vi.fn();

vi.mock("../../src/llm/langchain.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/llm/langchain.js")
  >("../../src/llm/langchain.js");
  return {
    ...actual,
    createLangChainModel: () => ({ stream }),
  };
});

const { AnswerLayer } = await import("../../src/pipeline/layers/AnswerLayer.js");

import type { AgentRunRequest } from "../../src/types.js";
import type { GraphStateValue } from "../../src/llm/state.js";
import type { LayerContext } from "../../src/pipeline/AgentLayer.js";

function chunks(...texts: string[]) {
  return (async function* () {
    for (const text of texts) {
      yield new AIMessageChunk({ content: text });
    }
  })();
}

const request = {
  requestId: "req-1",
  messageId: "msg-1",
  message: "how many orders?",
  history: [],
  llm: { connectionId: "l", provider: "anthropic", model: "m", apiKey: "k" },
} as unknown as AgentRunRequest;

function buildState(): GraphStateValue {
  return {
    answer: "",
    sql: "SELECT count(*) FROM orders",
    rows: [{ count: 3 }],
    columns: ["count"],
    rowCount: 1,
  } as unknown as GraphStateValue;
}

describe("AnswerLayer streaming", () => {
  const emit = vi.fn();
  const ctx = { emit, onLlmCall: vi.fn(), onLlmResponse: vi.fn() } as unknown as LayerContext;

  beforeEach(() => {
    emit.mockClear();
    stream.mockReset();
  });

  it("emits a message_delta per chunk and returns the joined answer", async () => {
    stream.mockResolvedValue(chunks("You have ", "three ", "orders."));

    const result = await new AnswerLayer().execute(request, buildState(), ctx);

    const deltas = emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "message_delta");

    expect(deltas.map((event) => event.data.delta)).toEqual([
      "You have ",
      "three ",
      "orders.",
    ]);
    expect(deltas.every((event) => event.data.messageId === "msg-1")).toBe(true);
    expect(result.answer).toBe("You have three orders.");
  });

  it("skips empty chunks so the client never sees a no-op delta", async () => {
    stream.mockResolvedValue(chunks("Hi", "", "there"));

    await new AnswerLayer().execute(request, buildState(), ctx);

    const deltas = emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.type === "message_delta");
    expect(deltas).toHaveLength(2);
  });

  it("does not call the model when there are no rows", async () => {
    const state = { ...buildState(), rows: [], rowCount: 0 } as GraphStateValue;

    const result = await new AnswerLayer().execute(request, state, ctx);

    expect(stream).not.toHaveBeenCalled();
    expect(result.answer).toBeTruthy();
  });
});
