import { Command } from "@langchain/langgraph";
import { invokeStructured } from "../llm/invoke.js";
import { VerifySchema } from "../llm/schemas.js";
import { VerifyPromptBuilder } from "../prompts/VerifyPromptBuilder.js";
import { MAX_GENERATIONS } from "./plan.js";
import { type NodeConfig, runtime, type State, type Update } from "./state.js";
import { planWebQuery } from "./web.js";

/**
 * Reviews an executed result against the question before it is shown.
 *
 * A query that runs is not necessarily right, and before this nothing checked.
 * A flagged result gets one rewrite with the reviewer's reason; the rewrite is
 * not reviewed again, so a reviewer that is wrong costs at most one extra
 * draft. A failed review call lets the result through rather than failing the
 * turn.
 */
export async function verify(state: State, config: NodeConfig) {
  const { request, step, hooks, signal } = runtime(config, "verify");
  const steps = [step("Checking that the result answers the question...")];

  let result;
  try {
    result = await invokeStructured({
      llm: request.llm,
      ...new VerifyPromptBuilder().build({
        knowledge: request.knowledge,
        question: state.question,
        sql: state.sql,
        columns: state.columns,
        rows: state.rows,
        rowCount: state.rowCount,
      }),
      name: "verify",
      light: true,
      temperature: 0,
      signal,
      ...hooks,
      schema: VerifySchema,
    });
  } catch (error) {
    return new Command({
      goto: "accept",
      update: {
        steps,
        toolCalls: [{ tool: "verification", error: error instanceof Error ? error.message : String(error) }],
      } satisfies Update,
    });
  }

  const { value, tokenUsage } = result;
  const problem = value.problem.trim();

  if (!value.answersQuestion && problem && state.generations < MAX_GENERATIONS) {
    return new Command({
      goto: "generate",
      update: {
        tokenUsage,
        verifyRetries: state.verifyRetries + 1,
        feedback: { sql: state.sql, issues: [`The query ran, but a review found a problem: ${problem}`] },
        steps: [...steps, step("The result does not look right; rewriting the query...")],
        repairHistory: [{ stage: "verification", sql: state.sql, problem }],
        toolCalls: [{ tool: "verification", answersQuestion: false, problem }],
      } satisfies Update,
    });
  }

  // The result stands, but may not be enough on its own: search as well.
  const webQuery = state.webQuery || planWebQuery(value.needsWeb, value.webQuery, request);
  return new Command({
    goto: "accept",
    update: {
      tokenUsage,
      steps: webQuery && !state.webQuery ? [...steps, step("The data alone may not be enough; checking the web too...")] : steps,
      toolCalls: [{ tool: "verification", answersQuestion: value.answersQuestion, problem, needsWeb: Boolean(webQuery) }],
      ...(webQuery ? { webQuery } : {}),
    } satisfies Update,
  });
}
