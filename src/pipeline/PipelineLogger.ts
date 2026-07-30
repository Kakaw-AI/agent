import { context, SpanStatusCode, trace, type Span } from "@opentelemetry/api";
import type { AgentRunRequest } from "../types.js";
import type { GraphStateValue } from "../llm/state.js";
import type { LlmCallHook, LlmResponseHook } from "../llm/types.js";
import {
  emitLog,
  layerDurationHistogram,
  llmTokenCounter,
  runCounter,
  tracer,
} from "../telemetry.js";

const IS_DEV = process.env.NODE_ENV !== "production";

// ANSI codes — no extra dependencies
const R = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GRAY = "\x1b[90m";

function ts(): string {
  return new Date().toISOString();
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms}ms`;
}

function tokStr(inTok: number, outTok: number): string {
  return `in=${inTok.toLocaleString()} out=${outTok.toLocaleString()} tokens`;
}

/** Caps a logged prompt or response so log volume stays independent of prompt size. */
const LOG_TEXT_LIMIT = 2000;

function truncateForLog(value: string): string {
  return value.length <= LOG_TEXT_LIMIT
    ? value
    : `${value.slice(0, LOG_TEXT_LIMIT)}… [${value.length - LOG_TEXT_LIMIT} more chars]`;
}

function write(line: string): void {
  process.stderr.write(line + "\n");
}

function writeJson(obj: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify({ ts: ts(), ...obj }) + "\n");
  // Mirror the structured event as an OTLP log so it reaches Loki without the
  // Docker-socket shipper. No-op when telemetry is disabled.
  const event = typeof obj.event === "string" ? obj.event : "";
  const level = /error|failed/.test(event) ? "error" : "info";
  emitLog(level, obj, { event });
}

type LayerStats = {
  startMs: number;
  inTokens: number;
  outTokens: number;
};

export class PipelineLogger {
  private request: AgentRunRequest;
  private layerStats = new Map<string, LayerStats>();
  private runStartMs = 0;
  private totalInTokens = 0;
  private totalOutTokens = 0;
  // OpenTelemetry: one root span per run, one child span per layer. These are
  // no-ops (non-recording spans) when telemetry is disabled.
  private runSpan?: Span;
  private layerSpans = new Map<string, Span>();

  constructor(request: AgentRunRequest) {
    this.request = request;
  }

  logRunStart(): void {
    this.runStartMs = Date.now();
    // Root span; parents to the active (incoming HTTP) span automatically, so
    // the trace links backend → agent → layers.
    this.runSpan = tracer.startSpan("agent.run", {
      attributes: {
        "agent.request_id": this.request.requestId,
        "agent.user_id": this.request.userId,
        "agent.message_id": this.request.messageId,
      },
    });
    if (IS_DEV) {
      const sep = "━".repeat(65);
      write(`\n${BOLD}${CYAN}${sep}${R}`);
      write(`${BOLD}  AGENT RUN${R}  req=${this.request.requestId}  user=${this.request.userId}  msg=${this.request.messageId}`);
      write(`  ${DIM}"${this.request.message}"${R}`);
      write(`${BOLD}${CYAN}${sep}${R}`);
    } else {
      writeJson({
        event: "run_started",
        requestId: this.request.requestId,
        userId: this.request.userId,
        messageId: this.request.messageId,
        message: this.request.message,
      });
    }
  }

  logLayerStarted(layerName: string): void {
    this.layerStats.set(layerName, { startMs: Date.now(), inTokens: 0, outTokens: 0 });
    if (this.runSpan) {
      this.layerSpans.set(
        layerName,
        tracer.startSpan(
          `agent.layer ${layerName}`,
          undefined,
          trace.setSpan(context.active(), this.runSpan),
        ),
      );
    }
    if (IS_DEV) {
      write(`\n  ${CYAN}▶${R} ${layerName}`);
    } else {
      writeJson({ event: "layer_started", layer: layerName });
    }
  }

  logLayerSkipped(layerName: string): void {
    this.runSpan?.addEvent("layer_skipped", { layer: layerName });
    if (IS_DEV) {
      write(`\n  ${GRAY}▶ ${layerName}  (skipped)${R}`);
    } else {
      writeJson({ event: "layer_skipped", layer: layerName });
    }
  }

  logLayerCompleted(layerName: string, result: Partial<GraphStateValue>, durationMs: number): void {
    const stats = this.layerStats.get(layerName) ?? { startMs: 0, inTokens: 0, outTokens: 0 };
    this.totalInTokens += stats.inTokens;
    this.totalOutTokens += stats.outTokens;

    layerDurationHistogram.record(durationMs, { "agent.layer": layerName });
    if (stats.inTokens) {
      llmTokenCounter.add(stats.inTokens, { "agent.layer": layerName, direction: "input" });
    }
    if (stats.outTokens) {
      llmTokenCounter.add(stats.outTokens, { "agent.layer": layerName, direction: "output" });
    }
    const completedSpan = this.layerSpans.get(layerName);
    if (completedSpan) {
      completedSpan.setAttributes({
        "agent.layer.duration_ms": durationMs,
        "agent.llm.input_tokens": stats.inTokens,
        "agent.llm.output_tokens": stats.outTokens,
      });
      completedSpan.end();
      this.layerSpans.delete(layerName);
    }

    if (IS_DEV) {
      const tokenPart = stats.inTokens > 0 ? `  ${GRAY}${tokStr(stats.inTokens, stats.outTokens)}${R}` : "";
      write(`  ${GREEN}✓${R} ${layerName.padEnd(28)} ${BOLD}${fmt(durationMs)}${R}${tokenPart}`);
    } else {
      writeJson({
        event: "layer_completed",
        layer: layerName,
        durationMs,
        inTokens: stats.inTokens,
        outTokens: stats.outTokens,
      });
    }
  }

  logLayerError(layerName: string, error: unknown, durationMs: number): void {
    const message = error instanceof Error ? error.message : String(error);
    layerDurationHistogram.record(durationMs, { "agent.layer": layerName, error: true });
    const erroredSpan = this.layerSpans.get(layerName);
    if (erroredSpan) {
      erroredSpan.recordException(message);
      erroredSpan.setStatus({ code: SpanStatusCode.ERROR, message });
      erroredSpan.end();
      this.layerSpans.delete(layerName);
    }
    if (IS_DEV) {
      write(`  ${RED}✗${R} ${layerName}  ${RED}ERROR${R} after ${fmt(durationMs)}`);
      write(`    ${DIM}${message}${R}`);
    } else {
      writeJson({ event: "layer_error", layer: layerName, durationMs, error: message });
    }
  }

  logRunEnd(finalState: Partial<GraphStateValue>, durationMs: number): void {
    const outcome = (finalState as any).analyticsOutcome ?? "unknown";
    runCounter.add(1, { outcome: String(outcome) });
    if (this.runSpan) {
      this.runSpan.setAttributes({
        "agent.outcome": String(outcome),
        "agent.llm.total_input_tokens": this.totalInTokens,
        "agent.llm.total_output_tokens": this.totalOutTokens,
        "agent.duration_ms": durationMs,
      });
      this.runSpan.end();
      this.runSpan = undefined;
    }
    if (IS_DEV) {
      const sep = "━".repeat(65);
      write(`\n${BOLD}${CYAN}${sep}${R}`);
      write(`${BOLD}  DONE${R}  ${fmt(durationMs)} total  ${GRAY}${tokStr(this.totalInTokens, this.totalOutTokens)}${R}  outcome=${outcome}`);
      write(`${BOLD}${CYAN}${sep}${R}\n`);
    } else {
      writeJson({
        event: "run_completed",
        durationMs,
        totalInTokens: this.totalInTokens,
        totalOutTokens: this.totalOutTokens,
      });
    }
  }

  logRunError(message: string, durationMs: number): void {
    runCounter.add(1, { outcome: "error" });
    if (this.runSpan) {
      this.runSpan.recordException(message);
      this.runSpan.setStatus({ code: SpanStatusCode.ERROR, message });
      this.runSpan.end();
      this.runSpan = undefined;
    }
    if (IS_DEV) {
      const sep = "━".repeat(65);
      write(`\n${BOLD}${RED}${sep}${R}`);
      write(`${BOLD}${RED}  FAILED${R}  ${fmt(durationMs)}  ${message}`);
      write(`${BOLD}${RED}${sep}${R}\n`);
    } else {
      writeJson({ event: "run_failed", durationMs, error: message });
    }
  }

  onLlmCall(layerName: string): LlmCallHook {
    return ({ systemPrompt, userPrompt, model, temperature }) => {
      const stats = this.layerStats.get(layerName);
      if (IS_DEV) {
        write(`    ${YELLOW}[LLM]${R} model=${model}  temp=${temperature}`);
        write(`    ${DIM}SYSTEM: ${systemPrompt.slice(0, 120).replace(/\n/g, " ")}...${R}`);
        write(`    ${DIM}USER:   ${userPrompt.slice(0, 120).replace(/\n/g, " ")}${R}`);
        write(`    ${"─".repeat(50)}`);
      } else {
        // Truncated: the system prompt carries the entire schema catalog, so
        // logging it whole made production log volume scale with prompt size,
        // to stderr and OTLP both.
        writeJson({
          event: "llm_call",
          layer: layerName,
          model,
          temperature,
          systemPromptLength: systemPrompt.length,
          systemPrompt: truncateForLog(systemPrompt),
          userPromptLength: userPrompt.length,
          userPrompt: truncateForLog(userPrompt),
        });
      }
      // suppress unused warning — stats will be updated by onLlmResponse
      void stats;
    };
  }

  onLlmResponse(layerName: string): LlmResponseHook {
    return ({ content, tokenUsage }) => {
      const stats = this.layerStats.get(layerName);
      const inTok = tokenUsage?.inputTokens ?? 0;
      const outTok = tokenUsage?.outputTokens ?? 0;
      if (stats) {
        stats.inTokens += inTok;
        stats.outTokens += outTok;
      }
      if (IS_DEV) {
        write(`    ${DIM}RESPONSE (out=${outTok} tokens):${R}`);
        write(`    ${DIM}${content.slice(0, 300).replace(/\n/g, " ")}${R}`);
      } else {
        writeJson({
          event: "llm_response",
          layer: layerName,
          inTokens: inTok,
          outTokens: outTok,
          cacheReadTokens: tokenUsage?.cacheReadTokens ?? 0,
          cacheWriteTokens: tokenUsage?.cacheWriteTokens ?? 0,
          contentLength: content.length,
          content: truncateForLog(content),
        });
      }
    };
  }
}
