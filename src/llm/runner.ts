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

export async function runAgent(request: AgentRunRequest): Promise<AgentStreamEvent[]> {
  return new AgentPipeline()
    .use(new IntentLayer())
    .use(new SqlGenerationLayer())
    .use(new SqlExecutionLayer())
    .use(new AnswerLayer())
    .use(new ChartLayer())
    .use(new SuggestionsLayer())
    .run(request);
}
