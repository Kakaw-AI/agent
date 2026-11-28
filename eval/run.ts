/**
 * Runs the cases in eval/cases.ts through the agent's real entry point and
 * scores each result set against the correct SQL.
 *
 *   npx tsx eval/run.ts --label new [--only b1,f2] [--concurrency 2] [--fresh true]
 *   npx tsx eval/run.ts --fixture messy --label messy-base
 *
 * `--fixture shop` (default) is a clean five-table SQLite file. `--fixture
 * messy` is the legacy-style PostgreSQL ERP from eval/messy/seed.ts, read
 * through the URL in eval/.env.messy, for measuring what schema knowledge adds.
 *
 * Results accumulate in eval/results/<label>.json, written after every case,
 * so runs can be split with --only and an interrupted run loses nothing.
 *
 * Defaults to the local LM Studio server, so a run costs nothing. Point it at
 * another OpenAI-compatible endpoint with EVAL_BASE_URL / EVAL_MODEL /
 * EVAL_API_KEY.
 *
 * Self-contained on purpose (gold queries and the SQLite cache path are done
 * here, not imported), so the same harness can score an older checkout of the
 * agent.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { CASES, type EvalCase } from "./cases.js";
import { MESSY_CASES } from "./messy/cases.js";
import { resultsMatch } from "./score.js";
import { seedShopDatabase } from "./seed.js";

// Read by the agent's config at import time, so set before importing it. A
// local model on a laptop is far slower than a hosted one.
process.env.LLM_TIMEOUT_MS ??= "900000";
process.env.NODE_ENV ??= "development";

const here = dirname(fileURLToPath(import.meta.url));
const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index].replace(/^--/, ""), process.argv[index + 1] ?? "");
}
const label = args.get("label") || "run";
const only = args.get("only")?.split(",").filter(Boolean);
const concurrency = Number(args.get("concurrency") || 2);
const fresh = args.get("fresh") === "true";
const fixture = args.get("fixture") || "shop";
if (fixture !== "shop" && fixture !== "messy") throw new Error(`Unknown fixture ${fixture}`);
const ALL_CASES = fixture === "messy" ? MESSY_CASES : CASES;

const BASE_URL = process.env.EVAL_BASE_URL || "http://127.0.0.1:1234/v1";
const MODEL = process.env.EVAL_MODEL || "qwen/qwen3.5-9b";
const API_KEY = process.env.EVAL_API_KEY || "lm-studio";
const LOCAL = BASE_URL.includes("127.0.0.1") || BASE_URL.includes("localhost");
// Qwen-style local models reason for hundreds of tokens before answering.
// Only the eval process turns that off; the agent's prompts are unchanged.
const NO_THINK = LOCAL && process.env.EVAL_NO_THINK !== "false";
// The written answer, the follow-up suggestions and the chart plan do not
// affect which rows come back, and on a laptop model the answer alone took
// most of each case's 20+ minutes. They get canned replies unless asked for.
const REAL_FINISH = process.env.EVAL_REAL_FINISH === "true";

// ── model traffic: metrics, no-think, canned replies ───────────────────────
type Metrics = { llmCalls: number; inputTokens: number; outputTokens: number };
const metricsScope = new AsyncLocalStorage<Metrics>();

function readUsage(text: string, metrics: Metrics) {
  const candidates = text.trim().startsWith("{")
    ? [text]
    : text.split("\n").filter((line) => line.startsWith("data:") && line.includes('"usage"')).map((line) => line.slice(5));
  for (const candidate of candidates) {
    try {
      const usage = JSON.parse(candidate).usage;
      if (usage) {
        metrics.inputTokens += usage.prompt_tokens ?? 0;
        metrics.outputTokens += usage.completion_tokens ?? 0;
      }
    } catch {
      // not JSON
    }
  }
}

type ChatBody = {
  model: string;
  stream?: boolean;
  tools?: Array<{ function: { name: string } }>;
  messages: Array<{ role: string; content: unknown }>;
  stream_options?: unknown;
};

function cannedJson(body: ChatBody, payload: unknown): Response {
  const toolName = body.tools?.[0]?.function.name;
  const message = toolName
    ? { role: "assistant", content: null, tool_calls: [{ id: "call_eval", type: "function", function: { name: toolName, arguments: JSON.stringify(payload) } }] }
    : { role: "assistant", content: JSON.stringify(payload) };
  return new Response(
    JSON.stringify({
      id: "eval",
      object: "chat.completion",
      created: 0,
      model: body.model,
      choices: [{ index: 0, message, finish_reason: toolName ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function cannedStream(body: ChatBody, text: string): Response {
  const chunk = (delta: object, finish: string | null) =>
    `data: ${JSON.stringify({ id: "eval", object: "chat.completion.chunk", created: 0, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return new Response(chunk({ role: "assistant", content: text }, null) + chunk({}, "stop") + "data: [DONE]\n\n", {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function cannedReply(body: ChatBody): Response | null {
  if (REAL_FINISH) return null;
  const system = String(body.messages.find((message) => message.role === "system")?.content ?? "");
  if (body.stream) return cannedStream(body, "Here are the results.");
  if (system.includes("proposing what to explore NEXT")) {
    return cannedJson(body, { suggestions: ["Show more?", "Break it down?", "Compare?"] });
  }
  if (system.includes("You plan D3 visualizations")) {
    return cannedJson(body, { kind: "bar", title: "", xField: "__none__", yField: "__none__" });
  }
  return null;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes("/chat/completions") || typeof init?.body !== "string") {
    return realFetch(input, init);
  }

  const body = JSON.parse(init.body) as ChatBody;
  const canned = cannedReply(body);
  if (canned) return canned;

  if (NO_THINK) {
    const last = [...body.messages].reverse().find((message) => message.role === "user");
    if (last && typeof last.content === "string") last.content += " /no_think";
  }
  if (body.stream) body.stream_options = { include_usage: true };

  const metrics = metricsScope.getStore();
  const response = await realFetch(input, { ...init, body: JSON.stringify(body) });
  if (metrics) {
    metrics.llmCalls += 1;
    void response.clone().text().then((text) => readUsage(text, metrics)).catch(() => undefined);
  }
  return response;
};

// ── the agent under test ───────────────────────────────────────────────────
type AgentRunRequest = import("../src/types.js").AgentRunRequest;
type AgentHistoryMessage = import("../src/types.js").AgentHistoryMessage;
type StreamAgent = (request: AgentRunRequest) => AsyncGenerator<{ type: string; data: any }>;

async function loadEntry(): Promise<StreamAgent> {
  // The graph replaced the layered pipeline; older checkouts export from runner.
  for (const path of ["../src/agent/graph.js", "../src/llm/runner.js"]) {
    try {
      return (await import(path)).streamAgent as StreamAgent;
    } catch {
      // try the next layout
    }
  }
  throw new Error("No streamAgent export found.");
}
const streamAgent = await loadEntry();
const { syncDatabase } = await import("../src/database/knowledge.js");

// ── fixture ────────────────────────────────────────────────────────────────
type GoldResult = { columns: string[]; rows: Array<Record<string, unknown>> };
let database: import("../src/types.js").AgentDatabaseRuntime;
let gold: (sql: string) => Promise<GoldResult>;

if (fixture === "messy") {
  const envPath = join(here, ".env.messy");
  if (!existsSync(envPath)) throw new Error("Run eval/messy/seed.ts first; it writes eval/.env.messy.");
  const url = readFileSync(envPath, "utf8").match(/^MESSY_READER_URL=(.+)$/m)?.[1]?.trim();
  if (!url) throw new Error("MESSY_READER_URL is missing from eval/.env.messy.");
  database = { sourceId: "eval-messy", provider: "postgresql", label: "Messy ERP (eval)", connectionString: url };
  const goldClient = new pg.Client({ connectionString: url });
  await goldClient.connect();
  gold = async (sql) => {
    const result = await goldClient.query(sql);
    return { columns: result.fields.map((field) => field.name), rows: result.rows };
  };
} else {
  const seedPath = join(here, ".data", "shop.sqlite");
  seedShopDatabase(seedPath);
  database = {
    sourceId: "eval-shop",
    provider: "sqlite",
    label: "Shop (eval)",
    sqliteObjectKey: "eval/shop.sqlite",
    sqliteOriginalFilename: "shop.sqlite",
  };
  // Where the agent looks for a downloaded SQLite file (src/database/materialize.ts).
  const cached = join(tmpdir(), "kakaw-sqlite", `${Buffer.from(database.sqliteObjectKey!).toString("hex")}.sqlite`);
  mkdirSync(dirname(cached), { recursive: true });
  copyFileSync(seedPath, cached);
  const goldDb = new Database(seedPath, { readonly: true });
  gold = async (sql) => {
    const statement = goldDb.prepare(sql);
    return { columns: statement.columns().map((column) => column.name), rows: statement.all() as Array<Record<string, unknown>> };
  };
}

const sync = await syncDatabase(database);
database.schemaFingerprint = sync.schemaFingerprint;
// The shape the backend sends: stored columns with their sample values, no
// sample rows.
const knowledge = {
  schemaFingerprint: sync.schemaFingerprint,
  summary: `${sync.catalog.tables.length} tables`,
  tables: sync.catalog.tables,
};

async function historyFor(testCase: EvalCase): Promise<AgentHistoryMessage[]> {
  const turns = await Promise.all(
    (testCase.history ?? []).map(async (turn) => ({ turn, result: await gold(turn.sql) })),
  );
  return turns.flatMap(({ turn, result }): AgentHistoryMessage[] => {
    return [
      { role: "user", content: turn.question },
      // What the backend stores with an assistant message.
      { role: "assistant", content: `Here are the results for "${turn.question}".`, rows: result.rows, columns: result.columns, sql: turn.sql },
    ];
  });
}

// ── one case ───────────────────────────────────────────────────────────────
type CaseResult = {
  id: string;
  category: EvalCase["category"];
  question: string;
  pass: boolean;
  reason: string;
  clarified: boolean;
  expectedSql?: string;
  agentSql?: string;
  rowCount?: number;
  answer?: string;
  /** What the run went through beyond one draft: repairs, value checks, review verdicts. */
  path?: string[];
  seconds: number;
} & Metrics;

async function runCase(testCase: EvalCase): Promise<CaseResult> {
  const metrics: Metrics = { llmCalls: 0, inputTokens: 0, outputTokens: 0 };
  const started = Date.now();
  const request: AgentRunRequest = {
    requestId: `eval-${label}-${testCase.id}`,
    conversationId: `eval-${testCase.id}`,
    userId: "eval",
    messageId: `msg-${testCase.id}`,
    message: testCase.question,
    history: await historyFor(testCase),
    database,
    knowledge,
    llm: { connectionId: "eval", provider: "lm-studio", model: MODEL, apiKey: API_KEY, baseUrl: BASE_URL },
    ...(testCase.exactPlanSql ? { retrieval: { exactPlan: { memoryId: "eval-memory", sql: testCase.exactPlanSql } } } : {}),
  };

  const events: Array<{ type: string; data: Record<string, any> }> = [];
  let crash: string | null = null;
  try {
    await metricsScope.run(metrics, async () => {
      for await (const event of streamAgent(request)) events.push(event);
    });
  } catch (error) {
    crash = error instanceof Error ? error.message : String(error);
  }

  const last = (type: string) => [...events].reverse().find((event) => event.type === type)?.data;
  const result = last("sql_result");
  const completed = last("message_completed");
  const failed = last("message_failed");
  const trace = last("agent_trace");
  const answer: string = completed?.content ?? "";
  const clarified =
    !result && !!completed && (trace?.analyticsOutcome === "clarification" || /\?\s*$/.test(answer.trim()));

  let pass = false;
  let reason: string;
  if (crash) {
    reason = `crashed: ${crash}`;
  } else if (testCase.category === "greeting") {
    pass = !result && !!completed;
    reason = pass ? "ok" : "queried the database for a greeting";
  } else if (testCase.category === "ambiguous") {
    pass = clarified;
    reason = pass ? "asked a clarifying question" : "answered without asking";
  } else if (!result) {
    reason = failed ? `failed: ${failed.error}` : clarified ? "asked instead of answering" : "no result";
  } else {
    pass = resultsMatch(await gold(testCase.sql!), { columns: result.columns, rows: result.rows });
    reason = pass ? "ok" : "wrong result";
    if (pass && testCase.category === "chart_follow_up" && !last("chart_generated")) {
      pass = false;
      reason = "right rows, no chart";
    }
  }

  return {
    id: testCase.id,
    category: testCase.category,
    question: testCase.question,
    pass,
    reason,
    clarified,
    expectedSql: testCase.sql,
    agentSql: last("sql_generated")?.sql,
    rowCount: result?.rowCount,
    answer: answer.slice(0, 400),
    path: [
      ...((trace?.repairHistory ?? []) as Array<Record<string, any>>).map((entry) => `${entry.stage}${entry.problem ? `: ${entry.problem}` : entry.error ? `: ${entry.error}` : ""}`),
      ...((trace?.toolCalls ?? []) as Array<Record<string, any>>)
        .filter((call) => call.tool === "verification" || call.tool === "route")
        .map((call) => (call.tool === "route" ? `route: ${call.kind} "${call.standaloneQuestion ?? call.error}"` : `verification: ${call.answersQuestion ?? call.error}`)),
    ],
    seconds: Math.round((Date.now() - started) / 100) / 10,
    ...metrics,
  };
}

// ── results file ───────────────────────────────────────────────────────────
const resultsPath = join(here, "results", `${label}.json`);
mkdirSync(dirname(resultsPath), { recursive: true });
const results = new Map<string, CaseResult>();
if (!fresh && existsSync(resultsPath)) {
  for (const result of JSON.parse(readFileSync(resultsPath, "utf8")).results as CaseResult[]) {
    results.set(result.id, result);
  }
}

function summarize() {
  const all = ALL_CASES.map((testCase) => results.get(testCase.id)).filter((result): result is CaseResult => !!result);
  const sum = (pick: (result: CaseResult) => number) => all.reduce((total, result) => total + pick(result), 0);
  const average = (pick: (result: CaseResult) => number) => (all.length ? Math.round((sum(pick) / all.length) * 10) / 10 : 0);
  const byCategory: Record<string, string> = {};
  for (const category of [...new Set(all.map((result) => result.category))]) {
    const inCategory = all.filter((result) => result.category === category);
    byCategory[category] = `${inCategory.filter((result) => result.pass).length}/${inCategory.length}`;
  }
  return {
    summary: {
      label,
      fixture,
      model: MODEL,
      cannedFinish: !REAL_FINISH,
      updatedAt: new Date().toISOString(),
      passed: `${all.filter((result) => result.pass).length}/${all.length}`,
      byCategory,
      overAsked: all.filter((result) => result.clarified && result.category !== "ambiguous").length,
      avgLlmCalls: average((result) => result.llmCalls),
      avgInputTokens: Math.round(average((result) => result.inputTokens)),
      avgOutputTokens: Math.round(average((result) => result.outputTokens)),
      avgSeconds: average((result) => result.seconds),
    },
    results: all,
  };
}

function save() {
  writeFileSync(resultsPath, JSON.stringify(summarize(), null, 2));
}

// ── run ────────────────────────────────────────────────────────────────────
const selected = only ? ALL_CASES.filter((testCase) => only.includes(testCase.id)) : ALL_CASES;
const units: EvalCase[][] = [];
const groups = new Map<string, EvalCase[]>();
for (const testCase of selected) {
  if (!testCase.group) {
    units.push([testCase]);
    continue;
  }
  if (!groups.has(testCase.group)) {
    groups.set(testCase.group, []);
    units.push(groups.get(testCase.group)!);
  }
  groups.get(testCase.group)!.push(testCase);
}

let next = 0;
await Promise.all(
  Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (next < units.length) {
      const unit = units[next++];
      for (const testCase of unit) {
        const result = await runCase(testCase);
        // Usage from streamed responses is read asynchronously.
        await new Promise((resolve) => setTimeout(resolve, 200));
        results.set(result.id, result);
        save();
        console.log(`${result.pass ? "PASS" : "FAIL"} ${result.id.padEnd(3)} ${String(result.seconds).padStart(6)}s  calls=${result.llmCalls}  ${result.reason}`);
      }
    }
  }),
);

console.log(JSON.stringify(summarize().summary, null, 2));
process.exit(0);
