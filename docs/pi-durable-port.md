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
| `src/app/runtime.ts` (Cordis `Service`, panel, HTTP routes) | `src/pi/runtime.ts` (thin host) + `src/plugin/` (the `superagent` extension) |
| `src/executor/dsh.ts` (DSH worker Sessions + workspaces) | `src/plugin/worker.ts` (durable `superagent.worker` task per Ticket, `CodingTools`) |
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
Feishu WS ──▶ FeishuSource ──▶ plugin.ingest(Trigger) ──▶ Passes.receive
                                   │
                              Engine.receive / evaluateDue
                                   │  Gate (allow-list / admission) → Mandate
                              GlmAssessor (glm-5.3, JSON decision)
                                   │  accept
                              Ticket ──▶ PluginExecutor.start
                                   │   root `superagent.worker` task (background, harness-anchored)
                                   │   └─ tx.createConversation (task-owned, CodingTools, cwd=/work/superagent/<id>)
                              Worker turn ──▶ report(ready, summary)
                                   │
                              Engine.reply(result) ──▶ FeishuOutbox ──▶ Feishu reply
```

Durability: ticket/thread/decision state in `orchestrator.sqlite` (WAL, locked state dir); worker
transcripts in `harness/` JSONL with `fsync`; interrupted `running` assignments are reported as
`hostRestarted` on boot so the domain can retry; outbox receipts survive a crash.

## Plugin

Everything the domain does is packaged as a pi-durable **extension**, installable into any
`pi-durable` Harness (the host in `src/pi/runtime.ts` is just one installer):

```ts
import { createSuperagentExtension } from 'pi-durable-superagent/plugin'

const superagent = createSuperagentExtension({
  stateDir: '/workspace/.superagent',   // SQLite (tickets, decisions, outbox)
  workDir: '/work',                     // worker cwd root: /work/superagent/<ticket>
  maxWorkers: 3,                        // concurrent worker conversations
  evalMode: 'auto',                     // 'auto' | 'observe' | 'off'
  router: { provider: 'zhipu', model: 'glm-5.3' },
  worker: { provider: 'zhipu', model: 'glm-5.3' },
  channel: { send: message => feishu.send(message) },  // host owns transport
})

const registry = createRegistry()
registry.install(CodingTools)
registry.install(superagent)
const harness = await Harness.open(storage, { models, registry, env }, BACKGROUND_CONTEXT)
superagent.bind(harness)
await superagent.start()            // recovers interrupted work, resumes harness tasks
// inbound: superagent.ingest(trigger)
await superagent.stop()
```

The extension is named `superagent` and brings:

- **Tools** — `superagent_dispatch` (accept a request: Ticket + acknowledgement + durable worker,
  returns the ticket id), `superagent_status` (open/ended tickets with assignment state and last
  report), `superagent_cancel` (stop a ticket's worker), `superagent_report` (worker-side
  ready/blocked/failed with summary; a `ready` report also delivers the result).
- **A section** documenting the tools; worker language follows the user's.
- **The `superagent.worker` task** — the durable worker: a background root task anchored to the
  host's root conversation, which creates its conversation with `tx.createConversation` (task
  owned, `CodingTools` model config, `cwd` per ticket) and never depends on host closures.

Config fields (see `src/plugin/config.ts` for the full list): `stateDir`, `workDir`, `harnessDir`,
`maxWorkers`, `evalMode`, `router`/`worker` `{provider, model}`, `channel.send`, plus optional
`scope` (trigger scoping), `source` (default trigger source name), `allowAll`/`allowedActors`
(admission), `unaddressedAdmission`, `assessor` (`baseUrl`, `apiKeyEnv`), `workerTurnTimeoutMs`,
`replyLanguage`, `log`.

**The host owns**: process lifecycle, the harness and storage (`Harness.open`), model providers,
the execution environment, the inbound transport (Feishu WebSocket, selftest memory channel) —
triggers are fed to the plugin via `ingest()` — and the outbound transport through the
`channel.send` callback. The plugin never imports Feishu.

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
docker build -f deploy/Dockerfile -t changediff/pi-agent:superagent-plugin .
bash deploy/docker-run.sh      # recreates the pi-agent container on the new image
```

`/etc/piagent.env` must gain `ZHIPU_API_KEY` (and optionally the `SUP_*` overrides). Rollback:

```bash
sed -i 's#changediff/pi-agent:superagent-plugin#changediff/pi-agent:superagent#' deploy/docker-run.sh
bash deploy/docker-run.sh
```

## Known limits

- **No per-ticket sandbox.** Like the DSH prototype, a worker runs as the container user with
  `CodingTools`; directory isolation is not a security boundary.
- **One source.** Feishu only; GitHub events, web panel, prompt overrides and rule-based assessment are
  not ported.
- **Inferred candidates are observed, not executed.** The chat port admits explicit requests
  (mention/DM from an allowed sender) and records inferred ones without creating tickets.
- **Schema 10 databases are refused**; the port starts from a fresh state directory.
