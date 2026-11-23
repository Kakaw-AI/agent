import 'dotenv/config';

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { checkSignatureHeaders, SignatureError, verifyIncomingSignature } from "./auth.js";
import { loadInfisicalSecrets } from "./config/infisical.js";
import { syncDatabase } from './database/knowledge.js';
import { streamAgent } from "./agent/graph.js";
import { assertPublicUrl } from "./net/public-host.js";
import { emitLog, latitude, shutdownTelemetry } from "./telemetry.js";
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

    const timestamp = headerValue(request.headers["x-kakaw-request-timestamp"]);
    const signature = headerValue(request.headers["x-kakaw-signature"]);
    checkSignatureHeaders(timestamp, signature);
    const rawBody = await readBody(request);
    verifyIncomingSignature(timestamp, signature, rawBody);

    if (request.url === "/api/chat/sync") {
      const payload = JSON.parse(rawBody) as AgentSyncRequest;
      const result = await syncDatabase(payload.database);

      writeJson(response, 200, result);
      return;
    }

    if (request.url === "/api/chat/run") {
      const payload = JSON.parse(rawBody) as AgentRunRequest;
      // Before the stream starts, so a refusal is still a normal error response.
      if (payload.llm?.baseUrl) {
        await assertPublicUrl(payload.llm.baseUrl);
      }

      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
      });

      // When the backend hangs up (the user left), stop the run: in-flight model
      // calls and queries are aborted instead of finishing for nobody.
      const cancel = new AbortController();
      response.on("close", () => {
        if (!response.writableFinished) cancel.abort();
      });

      for await (const event of streamAgent(payload, cancel.signal)) {
        response.write(`${JSON.stringify(event)}\n`);
      }

      response.end();
      return;
    }

    writeJson(response, 404, { error: { message: "Not found." } });
  } catch (error) {
    if (error instanceof SignatureError) {
      emitLog("warn", `Rejected unsigned request: ${error.message}`, { statusCode: 401, url: request.url ?? "" });
      writeJson(response, 401, { error: { message: error.message, code: "AGENT_UNAUTHORIZED", statusCode: 401, retryable: false } });
      return;
    }
    const message = error instanceof Error && error.message.trim() ? error.message.trim() : "Unexpected agent failure.";
    console.error("Error handling request:", { message, statusCode: 500 });
    emitLog("error", `Error handling request: ${message}`, { statusCode: 500, url: request.url ?? "" });
    writeJson(response, 500, { error: { message, code: "AGENT_RUNTIME_ERROR", statusCode: 500, retryable: false } });
  }
});

async function main() {
  // Load secrets (AGENT_SHARED_SECRET, etc.) before accepting requests.
  await loadInfisicalSecrets();

  // Latitude's exporter finishes wiring up asynchronously; waiting here means
  // the very first request is traced too, not just the ones after warm-up.
  await latitude?.ready;

  const host = process.env.HOST?.trim() || "0.0.0.0";
  const port = Number(process.env.PORT ?? 8000);

  server.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`agent-ts listening on http://${host}:${port}`);
    emitLog("info", `agent-ts listening on http://${host}:${port}`, { event: "startup" });
  });
}

// Stop accepting connections and let in-flight runs finish before exiting.
// Docker's default stop grace period is 10s, so the wait is capped inside it;
// raise both together if long runs should survive a deploy.
function shutdown() {
  const drained = new Promise<void>((resolve) => server.close(() => resolve()));
  const deadline = new Promise<void>((resolve) => {
    setTimeout(resolve, 8_000).unref();
  });
  void Promise.race([drained, deadline])
    .then(shutdownTelemetry)
    .finally(() => process.exit(0));
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Failed to start agent-ts:", error);
  emitLog("error", `Failed to start agent-ts: ${error instanceof Error ? error.message : String(error)}`, { event: "startup_failed" });
  process.exit(1);
});

// Run requests carry the schema catalog and recent result rows, so they are
// large, but not unbounded: the body is buffered before the signature check.
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer | string) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error("Request body is too large."));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
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
