import { describeAssistantTurn, recentHistory } from "../llm/messages.js";
import type { AgentHistoryMessage } from "../types.js";

/** Characters of a replayed assistant turn; the router needs its gist, not every row. */
const MAX_TURN_CHARS = 1500;

/**
 * Turns the newest message into a question that stands on its own.
 *
 * Everything downstream (the plan cache, query memory, SQL generation, the
 * answer) works on that standalone question. Keyed on the raw text, "what
 * about 2025?" asked after two different questions looked like one question.
 */
export class RoutePromptBuilder {
  build(input: { history: AgentHistoryMessage[]; message: string }): {
    systemPrompt: string;
    userPrompt: string;
  } {
    const transcript = recentHistory(input.history)
      .map((message) => {
        if (message.role === "user") return `User: ${message.content}`;
        const turn = describeAssistantTurn(message);
        return `Assistant: ${turn.length > MAX_TURN_CHARS ? `${turn.slice(0, MAX_TURN_CHARS)}...` : turn}`;
      })
      .join("\n\n");

    return {
      systemPrompt: [
        "You read a conversation between a user and a data analyst assistant that answers questions by querying a database, followed by the user's newest message.",
        "Return JSON with two fields:",
        '- kind: "chart_previous" when the newest message only asks to chart, plot or visualize the previous result without changing the data; "small_talk" when it is a greeting, thanks or chit-chat that asks for no data; otherwise "data".',
        "- standaloneQuestion: the newest message rewritten as one complete question that can be understood without the conversation. Carry over every table, metric, filter, grouping and time range it inherits from earlier turns, and apply exactly what the newest message changes. Keep the user's wording where you can. If the newest message is already complete on its own, return it unchanged.",
        "Do not answer the question.",
      ].join("\n"),
      userPrompt: `Conversation:\n${transcript}\n\nNewest message: ${input.message}`,
    };
  }
}
