import { describe, it, expect } from "vitest";
import { EdgeBuilder } from "../../src/pipeline/AgentLayer.js";

describe("EdgeBuilder", () => {
  it("accumulates unconditional edges via to()", () => {
    const builder = new EdgeBuilder();
    const fakeLayer = { name: "target" } as any;
    builder.to(fakeLayer);
    expect(builder.getEdges()).toEqual([
      { kind: "unconditional", target: fakeLayer },
    ]);
  });

  it("accumulates conditional edges via when()", () => {
    const builder = new EdgeBuilder();
    const fakeLayer = { name: "target" } as any;
    const cond = (s: any) => s.foo === true;
    builder.when(cond, fakeLayer);
    expect(builder.getEdges()).toEqual([
      { kind: "conditional", condition: cond, target: fakeLayer },
    ]);
  });

  it("supports chaining", () => {
    const builder = new EdgeBuilder();
    const a = { name: "a" } as any;
    const b = { name: "b" } as any;
    builder.to(a).to(b);
    expect(builder.getEdges()).toHaveLength(2);
  });
});
