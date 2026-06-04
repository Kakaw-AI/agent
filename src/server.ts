import 'dotenv/config';

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { verifyIncomingSignature } from "./auth.js";
import { loadInfisicalSecrets } from "./config/infisical.js";
import { syncDatabase } from './database/knowledge.js';
import { streamAgent } from './llm/runner.js';
import type { AgentRunRequest, AgentSyncRequest } from "./types.js";


const server = createServer(async (request, response) => {

  try {
    if (request.method === "GET" && request.url === "/healthz") {
      writeJson(response, 200, { status: "ok" });
      return;
    }

    if (request.method !== "POST") {
      writeJson(response, 404, { error: { message: "Not found." } });
      return;
    }

    const rawBody = await readBody(request);
    verifyIncomingSignature(
      headerValue(request.headers["x-kakaw-request-timestamp"]),
      headerValue(request.headers["x-kakaw-signature"]),
      rawBody,
    );

    if (request.url === "/api/chat/sync") {
      const payload = JSON.parse(rawBody) as AgentSyncRequest;
      const result = await syncDatabase(payload.database);

      writeJson(response, 200, result);
      return;
    }

    if (request.url === "/api/chat/run") {
      const payload = JSON.parse(rawBody) as AgentRunRequest;

      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });

      for await (const event of streamAgent(payload)) {
        response.write(`${JSON.stringify(event)}\n`);
      }

      response.end();
      return;
    }

    writeJson(response, 404, { error: { message: "Not found." } });
  } catch (error) {
    const message = error instanceof Error && error.message.trim() ? error.message.trim() : "Unexpected agent failure.";
    console.error("Error handling request:", { message, statusCode: 500 });
    writeJson(response, 500, { error: { message, code: "AGENT_RUNTIME_ERROR", statusCode: 500, retryable: false } });
  }
});

async function main() {
  // Load secrets (AGENT_SHARED_SECRET, etc.) before accepting requests.
  await loadInfisicalSecrets();

  const host = process.env.HOST?.trim() || "0.0.0.0";
  const port = Number(process.env.PORT ?? 8000);

  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`agent-ts listening on http://${host}:${port}`);
  });
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start agent-ts:", error);
  process.exit(1);
});

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function writeJson(
  response: ServerResponse<IncomingMessage>,
  statusCode: number,
  payload: unknown,
) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function headerValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}
