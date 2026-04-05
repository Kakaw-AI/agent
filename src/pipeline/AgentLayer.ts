import type { GraphStateValue } from "../llm/state.js";
import type { AgentRunRequest } from "../types.js";

export type LayerMap = Map<string, AgentLayer>;

export type EdgeDef =
  | { kind: "unconditional"; target: AgentLayer }
  | { kind: "conditional"; condition: (state: GraphStateValue) => boolean; target: AgentLayer };

export class EdgeBuilder {
  private _edges: EdgeDef[] = [];

  to(target: AgentLayer): this {
    this._edges.push({ kind: "unconditional", target });
    return this;
  }

  when(condition: (state: GraphStateValue) => boolean, target: AgentLayer): this {
    this._edges.push({ kind: "conditional", condition, target });
    return this;
  }

  getEdges(): EdgeDef[] {
    return this._edges;
  }
}

export abstract class AgentLayer {
  abstract readonly name: string;

  abstract execute(
    request: AgentRunRequest,
    state: GraphStateValue,
  ): Promise<Partial<GraphStateValue>>;

  shouldSkip?(state: GraphStateValue): boolean;
  edges?(builder: EdgeBuilder, layers: LayerMap): void;
}
