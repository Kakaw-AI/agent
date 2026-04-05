import type { AgentRunRequest } from "../types.js";
import type { GraphStateValue } from "../llm/state.js";
import type { LlmCallHook, LlmResponseHook } from "../llm/types.js";

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

function write(line: string): void {
  process.stderr.write(line + "\n");
}

function writeJson(obj: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify({ ts: ts(), ...obj }) + "\n");
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

  constructor(request: AgentRunRequest) {
    this.request = request;
  }

  logRunStart(): void {
    this.runStartMs = Date.now();
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
    if (IS_DEV) {
      write(`\n  ${CYAN}▶${R} ${layerName}`);
    } else {
      writeJson({ event: "layer_started", layer: layerName });
    }
  }

  logLayerSkipped(layerName: string): void {
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
    if (IS_DEV) {
      write(`  ${RED}✗${R} ${layerName}  ${RED}ERROR${R} after ${fmt(durationMs)}`);
      write(`    ${DIM}${message}${R}`);
    } else {
      writeJson({ event: "layer_error", layer: layerName, durationMs, error: message });
    }
  }

  logRunEnd(finalState: Partial<GraphStateValue>, durationMs: number): void {
    const outcome = (finalState as any).analyticsOutcome ?? "unknown";
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
        writeJson({
          event: "llm_call",
          layer: layerName,
          model,
          temperature,
          systemPrompt,
          userPrompt,
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
          content,
        });
      }
    };
  }
}
