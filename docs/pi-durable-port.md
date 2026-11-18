# pi-durable port

This branch replaces the DeepSeek Harness (DSH) runtime with
[`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) **1.5.2**
and runs the same Router/Worker domain against Feishu + GLM-5.3.

The point of the port is to keep the parts that were actually architecture — the Ticket state machine,
admission/Mandate, the outbox, the durable effect queue — and swap only the runtime adapters. The DSH
web panel, its session controller and the GitHub source are not part of this branch.

## Mapping

| DSH build | pi-durable port |
|---|---|
| `src/index.ts` (Cordis plugin, web client manifest) | `src/pi/main.ts` (process entry) |
| `src/app/runtime.ts` (Cordis `Service`, panel, HTTP routes) | `src/pi/runtime.ts` (composition root, no HTTP) |
| `src/executor/dsh.ts` (DSH worker Sessions + workspaces) | `src/pi/executor.ts` (one durable conversation per Ticket, `CodingTools`) |
| `src/app/assessment.ts` (main Session + `orchestrator_eval_*` tools) | `src/pi/assessor.ts` (one GLM JSON call) |
| `src/sources/feishu*.ts` (lark-cli shim + history polling) | `src/pi/feishu.ts` (lark SDK WebSocket + replies) |
| `src/app/outbox.ts` + `SourceRegistry` | `src/pi/outbox.ts` (single Feishu channel) |
| `src/app/sessions.ts`, `tools/`, `views/`, `http.ts`, `client/` | not ported — `docker logs` and SQLite replace the panel |
| `src/app/migration.ts` (schema 10 → 11) | rejects schema 10: start from a new state directory |
| `@deepseek-ai/*` cordis/DSH packages | `@earendil-works/pi-{ai,durable,schema}`, `chord` |

Kept unchanged: `src/core/*` (Engine, Intake, Evals, Tickets, Assignments, Replies), `src/policy.ts`,
`src/app/store.ts`, `src/app/effects.ts`, `src/app/passes.ts`, `src/kv.ts`.

## Runtime shape

```
Feishu WS ──▶ FeishuSource ──▶ Passes.receive(Trigger)
                                   │
                              Engine.receive / evaluateDue
                                   │  Gate (allow-list / admission) → Mandate
                              GlmAssessor (glm-5.3, JSON decision)
                                   │  accept
                              Ticket ──▶ PiExecutor.start
                                   │   harness.createConversation (per Ticket, CodingTools, cwd=/work/superagent/<id>)
                              Worker turn ──▶ report(ready, summary)
                                   │
                              Engine.reply(result) ──▶ FeishuOutbox ──▶ Feishu reply
```

Durability: ticket/thread/decision state in `orchestrator.sqlite` (WAL, locked state dir); worker
transcripts in `harness/` JSONL with `fsync`; interrupted `running` assignments are reported as
`hostRestarted` on boot so the domain can retry; outbox receipts survive a crash.

## Configuration (env)

| Key | Default | Meaning |
|---|---|---|
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | — | the bot app (same one the old pi-agent container used) |
| `FEISHU_DOMAIN` | `feishu` | `feishu` or `lark` |
| `ZHIPU_API_KEY` | — | GLM key (`SUP_API_KEY_ENV` names the variable) |
| `SUP_API_BASE` | `https://open.bigmodel.cn/api/coding/paas/v4` | OpenAI Chat Completions endpoint |
| `SUP_PROVIDER` / `SUP_MODEL` | `zhipu` / `glm-5.3` | Router model |
| `SUP_WORKER_PROVIDER` / `SUP_WORKER_MODEL` | same as Router | Worker model |
| `SUP_STATE_DIR` | `/workspace/.superagent` | SQLite + locks |
| `SUP_HARNESS_DIR` | `$SUP_STATE_DIR/harness` | pi-durable JSONL storage |
| `SUP_WORK_DIR` | `/work` | worker cwd root (`/work/superagent/<ticket>`) |
| `SUP_ALLOW_ALL` | `false` | admit every human sender (else `SUP_ALLOWED_OPEN_IDS` list) |
| `SUP_ALLOWED_OPEN_IDS` | empty | comma-separated Feishu `open_id`s |
| `SUP_LISTEN_ALL_CHATS` | `false` | receive unmentioned group messages too |
| `SUP_EVAL_MODE` | `auto` | `auto` / `observe` / `off` |
| `SUP_MAX_WORKERS` | `3` | concurrent durable worker conversations |
| `SUP_TURN_TIMEOUT_MS` | `1800000` | per-turn worker timeout |

## Run

```bash
export ZHIPU_API_KEY=... FEISHU_APP_ID=... FEISHU_APP_SECRET=...
node --experimental-transform-types src/pi/main.ts            # server
node --experimental-transform-types src/pi/main.ts --selftest # synthetic DM, memory channel
```

`--selftest` exercises the whole path (GLM assessment → ticket → durable worker → recorded reply)
without Feishu; it exits 0 on a real reply and 1 on timeout.

## Deploy (cc2)

```bash
cd /root/playground/pi-durable-superagent
docker build -f deploy/Dockerfile -t changediff/pi-agent:superagent .
bash deploy/docker-run.sh      # recreates the pi-agent container on the new image
```

`/etc/piagent.env` must gain `ZHIPU_API_KEY` (and optionally the `SUP_*` overrides). Rollback:

```bash
sed -i 's#changediff/pi-agent:superagent#changediff/pi-agent:v7#' /root/pi-agent/docker-run.sh
bash /root/pi-agent/docker-run.sh
```

## Known limits

- **No per-ticket sandbox.** Like the DSH prototype, a worker runs as the container user with
  `CodingTools`; directory isolation is not a security boundary.
- **One source.** Feishu only; GitHub events, web panel, prompt overrides and rule-based assessment are
  not ported.
- **Inferred candidates are observed, not executed.** The chat port admits explicit requests
  (mention/DM from an allowed sender) and records inferred ones without creating tickets.
- **Schema 10 databases are refused**; the port starts from a fresh state directory.
