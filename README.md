<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/banner-dark.svg">
  <img alt="agent — kakaw-ai by gitnasr" src=".github/banner-light.svg" width="100%">
</picture>

The agent behind [Kakaw AI](https://kakaw.gitnasr.com). It takes a question in plain English, writes SQL for the connected database, runs it, and returns the answer as a table or a chart.

[Backend](https://github.com/Kakaw-AI/backend) · [Frontend](https://github.com/Kakaw-AI/frontend) · [Monitoring](https://github.com/Kakaw-AI/monitoring) · [Site](https://kakaw.gitnasr.com)

## How it works

A LangGraph 1.x state graph in TypeScript, calling models through LangChain (Anthropic, OpenAI and Google are installed; Ollama and LM Studio go through the OpenAI-compatible client). The graph is built once in `src/agent/graph.ts`:

```
route ─┬─ small talk ───────────────────────────────────────► finalize
       ├─ "chart that" ─────────────────────────────────────► accept
       └─ data ─► cache ─┬─ reuse SQL ─► execute
                         └─ generate ◄──┐
                               │        │ repair, with what went wrong
                               ▼        │
                           execute ─────┤ (database error, bad shape)
                               │  └► checkValues (nothing found) ─┤
                               └──► verify ───────────────────────┘
                                       ▼
          accept ─► writeAnswer ∥ planChart ∥ suggestFollowUps ─► finalize
```

- **route** rewrites a follow-up ("what about 2025?") into a standalone question using the earlier turns and their SQL. The plan cache and query memory are keyed on that question, not the raw text.
- **generate** writes the SQL, or asks a clarifying question when the request has several readings that give different answers. The options come back as clickable suggestions.
- **execute** runs the query. A misspelled identifier is fixed without a model call; other errors go back to **generate** with the error.
- **checkValues** runs when nothing comes back (or a COUNT of 0). It looks up the values stored in the filtered columns: a difference in case only is fixed in place, anything else goes back to **generate** with the real values.
- **verify** reviews the result against the question once, and can send it back for one rewrite (`VERIFY_RESULTS=false` turns it off).
- **accept** sends the SQL and table to the client straight away; the answer, chart and suggestions are then produced in parallel.

### Accuracy

`eval/` holds 29 questions with known-correct SQL against a seeded shop database. They cover basics, filter values that differ from how people say them, questions that open with a greeting, follow-ups, "chart that" requests and ambiguous questions. Results in `eval/results/`, measured on a local `qwen/qwen3.5-9b` (thinking off; the written answer, suggestions and chart plan get canned replies because they do not change which rows come back):

| | Layered pipeline (before) | Graph (now) |
| --- | --- | --- |
| Correct results | 20/29 | 28/29 |
| Filter-value traps | 5/7 | 7/7 |
| Follow-ups | 5/7 | 7/7 |
| Questions starting with "hi" / "help me" | 0/2 | 2/2 |
| Chart follow-ups | 1/2 | 2/2 |
| Ambiguous, asked first | 0/2 | 1/2 |
| Model calls per question (SQL path) | 0.9 | 2.1 |

The extra calls are the routing call on follow-ups and the result review. Setting `VERIFY_RESULTS=false` removes the review.

The code in `src/`:

| Folder | What it does |
| --- | --- |
| `agent` | The graph: state, nodes, run logging |
| `graph` | Field resolution, chart specs, visualization checks |
| `llm` | Model calls, plan cache, intent helpers, schemas |
| `prompts` | Prompt text |
| `database` | Schema index, knowledge, query execution, row inference |
| `server.ts` | HTTP entry point (port 8000 in the image) |
| `telemetry.ts` | OpenTelemetry setup |

SQL is checked before it runs (`src/database/safety.ts`): one statement only, starting with `SELECT`, `WITH`, `EXPLAIN` or `PRAGMA`, and anything that writes or changes the schema is rejected. That check is a first filter. The boundary is in `src/database/query.ts`:

- Postgres queries run inside a read-only transaction with a statement timeout, through a cursor, so at most 200 rows leave the database.
- SQLite files are opened read-only in a separate process that is killed when a query passes the timeout.
- In production the agent will not connect to private or internal addresses, for the user's database or a custom LLM endpoint (`src/net/public-host.ts`).

## Run it

```bash
yarn install
yarn dev        # tsx watch src/server.ts
```

| Script | |
| --- | --- |
| `yarn build` | Compile with `tsc` |
| `yarn start` | Run `dist/server.js` with OpenTelemetry hooks |
| `yarn test` / `test:watch` | Vitest |
| `npx tsx eval/run.ts --label <name>` | Accuracy evaluation against a seeded shop database (see `eval/`) |

## Configuration

Settings come from Infisical (`src/config/infisical.ts`). The backend calls this service with an internal auth token. Never commit a `.env` file.

## Docker

`node:22-alpine`, multi-stage, exposes port 8000. CI builds and publishes the image on pushes to `master` and on `v*` tags.
