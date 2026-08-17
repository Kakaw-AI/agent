// OpenTelemetry bootstrap for the agent (ESM). Preloaded via `node --import`
// (see the `start` script / Dockerfile) so instrumentations patch modules
// before the server loads:
//   node --import @opentelemetry/instrumentation/hook.mjs --import ./dist/telemetry.js dist/server.js
//
// Driven entirely by the standard OTEL_* environment variables:
//   OTEL_EXPORTER_OTLP_ENDPOINT=https://alloy.gitnasr.com   (SDK appends /v1/{signal})
//   OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
//   OTEL_SERVICE_NAME=kakaw-agent
// Telemetry stays OFF unless an endpoint is configured.
//
// Latitude (LLM tracing) is configured separately and independently, via
// LATITUDE_API_KEY / LATITUDE_PROJECT_SLUG — see the bottom of this file.
import * as CallbackManagerModule from "@langchain/core/callbacks/manager";
import { Latitude } from "@latitude-data/telemetry";
import { createLangChainInstrumentation } from "@latitude-data/telemetry/instrumentations/langchain";
import { metrics, trace, type Tracer } from "@opentelemetry/api";
import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { HostMetrics } from "@opentelemetry/host-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

const SERVICE_NAME = process.env.OTEL_SERVICE_NAME ?? "kakaw-agent";
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();

let sdk: NodeSDK | undefined;

if (endpoint) {
  sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: SERVICE_NAME,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? "0.1.0",
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.NODE_ENV ?? "development",
    }),
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
    }),
    logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  new HostMetrics({ meterProvider: metrics.getMeterProvider() }).start();

  // eslint-disable-next-line no-console
  console.log(`[telemetry] OpenTelemetry started → ${endpoint}`);
}

// ── Latitude: LLM tracing ────────────────────────────────────────────────────
// Latitude is OpenTelemetry-based, so it composes with the setup above instead
// of replacing it: constructed after `sdk.start()`, it detects the global
// tracer provider and attaches its own span processor alongside the OTLP one.
// Every span keeps flowing to Alloy unchanged; Latitude additionally receives
// the LLM-relevant subset (its smart filter drops http/pg/dns spans).
//
// The LangChain instrumentation is what actually produces `gen_ai.*` spans —
// auto-instrumentations-node does not cover LangChain, so without it there are
// no model calls to trace. It patches the callback manager module directly, so
// it does not depend on this file being preloaded before `@langchain/*`.
//
// NOTE: this file is preloaded via `node --import` *before* server.ts, which is
// where Infisical secrets are fetched. LATITUDE_API_KEY is therefore read from
// the real process environment (container env / .env in dev), never Infisical —
// same as the OTEL_* vars above.
const latitudeApiKey = process.env.LATITUDE_API_KEY?.trim();
const latitudeProject = process.env.LATITUDE_PROJECT_SLUG?.trim();

/** Undefined when LATITUDE_API_KEY is unset — LLM tracing stays off. */
export const latitude = latitudeApiKey
  ? new Latitude({
      apiKey: latitudeApiKey,
      ...(latitudeProject ? { project: latitudeProject } : {}),
      instrumentations: [createLangChainInstrumentation(CallbackManagerModule)],
    })
  : undefined;

if (latitude) {
  // eslint-disable-next-line no-console
  console.log(
    `[telemetry] Latitude LLM tracing started → project=${latitudeProject ?? "(default)"}`,
  );
}

if (sdk || latitude) {
  const shutdown = () => {
    // Spans export on a batch interval; flush both pipelines before exiting or
    // the last run's spans are dropped.
    void Promise.allSettled([sdk?.shutdown(), latitude?.shutdown()]).finally(
      () => process.exit(0),
    );
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

// ── Instruments shared by the manual pipeline instrumentation ────────────────
export const tracer: Tracer = trace.getTracer(SERVICE_NAME);

const meter = metrics.getMeter(SERVICE_NAME);

/** Per-layer wall-clock duration. */
export const layerDurationHistogram = meter.createHistogram(
  "agent.layer.duration",
  { description: "Agent pipeline layer duration", unit: "ms" },
);

/** LLM token usage, split by direction ("input"/"output") and model. */
export const llmTokenCounter = meter.createCounter("agent.llm.tokens", {
  description: "LLM tokens consumed by the agent",
  unit: "{token}",
});

/** Completed runs, labelled by outcome. */
export const runCounter = meter.createCounter("agent.runs", {
  description: "Agent runs completed",
  unit: "{run}",
});

const otelLogger = logs.getLogger(SERVICE_NAME);

/** Emit a structured log record over OTLP (mirrors the JSON stderr events). */
export function emitLog(
  level: string,
  body: Record<string, unknown> | string,
  attributes: Record<string, unknown> = {},
): void {
  const severityNumber =
    level === "error" || level === "fatal"
      ? SeverityNumber.ERROR
      : level === "warn"
        ? SeverityNumber.WARN
        : level === "debug"
          ? SeverityNumber.DEBUG
          : SeverityNumber.INFO;

  otelLogger.emit({
    severityNumber,
    severityText: level,
    body: typeof body === "string" ? body : JSON.stringify(body),
    attributes: attributes as Record<string, string | number | boolean>,
  });
}
