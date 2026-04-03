import type { AgentRunRequest, AgentStreamEvent, AgentSyncRequest } from "./types.js";

const URL_SECRET_PATTERN = /\b(?:postgres(?:ql)?|mysql|mssql|mongodb|redis):\/\/\S+/gi;
const INLINE_SECRET_PATTERN =
  /\b(?:api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*[^\s,;]+/gi;

export function redactErrorMessage(message: string) {
  return message
    .replace(URL_SECRET_PATTERN, "[redacted-url]")
    .replace(INLINE_SECRET_PATTERN, (match) => {
      const separator = match.includes(":") ? ":" : "=";
      const key = match.split(separator)[0]?.trim() ?? "secret";
      return `${key}${separator}[redacted]`;
    });
}

export function buildRunRequestLogContext(request: AgentRunRequest) {
  return {
    requestId: request.requestId,
    conversationId: request.conversationId,
    messageId: request.messageId,
    userId: request.userId,
    message: request.message,
    messageLength: request.message.length,
    historyLength: request.history.length,
    database: {
      sourceId: request.database.sourceId,
      provider: request.database.provider,
      label: request.database.label,
      schemaFingerprint: request.database.schemaFingerprint ?? null,
    },
    llm: {
      connectionId: request.llm.connectionId,
      provider: request.llm.provider,
      model: request.llm.model,
    },
  };
}

export function buildSyncRequestLogContext(request: AgentSyncRequest) {
  return {
    requestId: request.requestId,
    userId: request.userId,
    database: {
      sourceId: request.database.sourceId,
      provider: request.database.provider,
      label: request.database.label,
      schemaFingerprint: request.database.schemaFingerprint ?? null,
    },
  };
}

export function summarizeAgentEvents(events: AgentStreamEvent[]) {
  const summary = {
    totalEvents: events.length,
    sqlCount: 0,
    tableCount: 0,
    chartCount: 0,
    failed: false,
    sqlPreview: null as string | null,
    resultRowCount: null as number | null,
    resultColumnCount: null as number | null,
    answerPreview: null as string | null,
  };

  for (const event of events) {
    if (event.type === "sql_generated") {
      summary.sqlCount += 1;
      summary.sqlPreview = event.data.sql.slice(0, 240);
    }
    if (event.type === "sql_result") {
      summary.tableCount += 1;
      summary.resultRowCount = event.data.rowCount;
      summary.resultColumnCount = event.data.columns.length;
    }
    if (event.type === "chart_generated") {
      summary.chartCount += 1;
    }
    if (event.type === "message_completed") {
      summary.answerPreview = event.data.content.slice(0, 240);
    }
    if (event.type === "message_failed") {
      summary.failed = true;
    }
  }

  return summary;
}

export function logAgentMessage(event: string, payload: Record<string, unknown>) {
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify({
      at: new Date().toISOString(),
      scope: "agent-ts",
      event,
      ...payload,
    }),
  );
}
