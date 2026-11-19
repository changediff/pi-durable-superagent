# 014 · OpenViking hub: memory-owned dispatch across peers

Status: design, 2026-11-19. Owner: superagent (pi-durable-superagent plugin).

## Goal

One conversation with **superagent**. It remembers (OpenViking), decides which agent
should do the work (hermes on cc2, cowagent on deb02, or itself), delegates over A2A,
and records what happened. Superagent is the **single writer of the shared memory
root**; every other agent keeps a `peers/<id>` space of its own.

```
                user
                  │  (feishu / A2A)
                  ▼
        ┌───────────────────┐        memory (single writer)
        │     superagent    │◄──────►  viking://user/<u>/memories/**            (shared root)
        │  plugin: openviking│         viking://user/<u>/peers/superagent/**   (own notes)
        │  plugin: peers     │
        └─────────┬─────────┘
      A2A JSON-RPC│
     ┌────────────┴─────────────┐
     ▼                          ▼
 hermes-cc2 :18801        cowagent-deb02 :18789/a2a/v1
 (通用/编码/运维/记忆写peer)  (家庭实验室/新闻/盯盘)
```

## Why a plugin, not a service

pi-durable already gives durable tasks, a worker turn loop, recall over tickets and a
device bridge. Memory and peer routing are **capabilities of the worker**, so they ship
as plugins installed in `src/pi/runtime.ts` next to `superagent`:

| plugin | tools | responsibility |
|---|---|---|
| `openviking` | `viking_search`, `viking_read`, `viking_write`, `viking_browse` | read/write the memory database, recall before planning, record outcomes |
| `peers` | `peer_list`, `peer_send` | A2A clients for peer agents, agent-card cache, capability summary |

Both are optional at runtime (`SUP_OPENVIKING=on`, `SUP_PEERS=on`); the worker runs
unchanged when they are off.

## Memory layout and single-writer rule

- Account/user: `default/default` (same tenant Hermes already uses).
- **Shared root** `viking://user/default/memories/**` — superagent writes here. This is
  the policy: entities (agents, servers, people), preferences, events.
- **Peer spaces** `viking://user/default/peers/<peer>/**` — each peer writes only here.
  Configured by the `X-OpenViking-Actor-Peer` header the daemon's client already sends
  (`OPENVIKING_AGENT`).
- Reading is open: superagent may read peer spaces; peers may read the shared root.
- Writes are append-or-replace by URI. No cross-writing, no locking beyond the
  single-writer rule — the server has no CAS, so concurrent writers on one URI lose data.
- Existing content from before this change (e.g. `peers/feishu.on_.../memories/...`) stays
  where it is; the plugin never moves it. Migration is a separate, deliberate task.

### What superagent stores, and when

| moment | URI shape | content |
|---|---|---|
| first contact with a person | `memories/entities/用户/<name>.md` | identity, preferences, standing instructions |
| learning a peer | `memories/entities/智能体/<peer>.md` | endpoint, skills, reliability notes, last success |
| finishing a delegated task | `memories/events/YYYY/MM/DD/<slug>.md` | who did what, outcome, links to ticket |
| durable decision | `memories/preferences/<topic>.md` | policy that should shape future dispatch |

Writes go through `viking_write` (content write) rather than session extraction, so the
text is exactly what the model intended; extraction is reserved for conversation commits.

## Peer routing

`peers` plugin config:

```yaml
peers:
  hermes-cc2:
    url: http://cc2.pig-bowfin.ts.net:18801/
    tokenEnv: A2A_BEARER_TOKEN       # resolved from plugin env, never in config file
    protocol: hermes                 # status.message.parts[].text
    skills: [coding, ops, memory, research]
  cowagent-deb02:
    url: http://deb02.pig-bowfin.ts.net:18789/a2a/v1
    tokenEnv: SUP_PEER_TOKEN_COW
    protocol: a2a                    # artifacts[].parts[].text
    skills: [host-ops, news, monitoring, family-lab]
```

- `peer_list()` refreshes agent cards (cached 10 min) and returns name, url, skills,
  online flag, last error.
- `peer_send({peer, text, contextId?, timeoutSec?})` sends JSON-RPC `SendMessage`
  (`hermes`) or `message/send` (`a2a`), polls `tasks/get` when the peer returns
  `TASK_STATE_WORKING`, and returns `{state, text, taskId, elapsedMs}`.
- Timeouts: default 300s, cap 900s; a timeout returns state `timeout` and keeps
  `taskId` so a later call can poll it.
- Unknown peer or unreachable peer → immediate error text, never a hang.

### Who does what (dispatch policy, remembered not hardcoded)

| need | first choice | fallback |
|---|---|---|
| code, repo, build, deploy on cc2 | hermes-cc2 | superagent's own worker |
| memory curation, research, long-form | hermes-cc2 | cowagent-deb02 |
| deb02 host, news briefings, home lab | cowagent-deb02 | hermes-cc2 |
| anything already in flight | the peer that owns the ticket | — |

The policy lives in memory (`memories/preferences/dispatch.md`) and in the brief, not in
an if-tree: the model reads it, the tools enforce mechanics.

## Worker brief additions

The `superagent` worker brief gains two optional sections, both truncated:

```
## 已知的 agent（peer_list，缓存）
## 相关记忆（viking_search 命中 3 条，超 1200 字只给摘要）
```

Recall is one search per ticket, not per turn. The worker may call the tools again if
the brief is insufficient.

## Failure modes

| failure | behaviour |
|---|---|
| OpenViking unreachable | tools return error text; worker continues without memory; logged once per run |
| peer offline | `peer_send` fails fast; model may pick another peer |
| peer replies `TASK_STATE_FAILED` | error text returned verbatim, outcome recorded in memory |
| memory write fails | non-fatal; outcome still reported to the user |
| two writers on one URI | prevented by the single-writer rule; peers never write the root |

## Non-goals

- No vector-store fork, no separate memory service, no background sync daemon.
- No automatic transcript commit per turn: extraction is expensive and the server owns it.
- No change to the A2A surface of pi-agent itself.
