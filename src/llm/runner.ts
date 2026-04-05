import type { AgentRunRequest, AgentStreamEvent } from "../types.js";
import {
  AgentPipeline,
  AnswerLayer,
  ChartLayer,
  IntentLayer,
  SqlExecutionLayer,
  SqlGenerationLayer,
  SuggestionsLayer,
} from "../pipeline/index.js";

function buildPipeline(): AgentPipeline {
  return new AgentPipeline()
    .use(new IntentLayer())
    .use(new SqlGenerationLayer())
    .use(new SqlExecutionLayer())
    .use(new AnswerLayer())
    .use(new ChartLayer())
    .use(new SuggestionsLayer());
}

export function streamAgent(request: AgentRunRequest): AsyncGenerator<AgentStreamEvent> {
  return buildPipeline().stream(request);
}

