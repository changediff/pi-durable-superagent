# BYOM / device-side daemon

Everything so far runs the model in **our** container with **our** keys. A device daemon inverts that:
the person runs the agent on their own machine, with their own model and their own credentials — BYOM
(bring your own model) — while the cloud stays the source of truth for tickets, threads, outbox and
the durable queue.

The daemon exists for three reasons: the person's files and credentials stay on their machine; their
model spend stays on their account; and a laptop or workstation becomes an executor without opening an
inbound port.

## Shape

```
Feishu ──▶ pi-agent (cloud)  ── assignment ──▶  device daemon  ──▶  local model + local tools
              ▲   durable queue, tickets                      │
              └────────────── result, usage ◀────────────────┘
```

The daemon only ever dials **out**. No inbound port, no tunnel, no public URL on the device — the same
property that makes it safe behind NAT and on a laptop.

## Protocol (first cut)

All calls carry `Authorization: Bearer <daemon token>`; the token is minted per device and can be
revoked without touching Feishu or model credentials.

| Call | Purpose |
|---|---|
| `POST /daemon/register` | announce `deviceId`, host label, capabilities (`tools`, `workdirs`), model label; answer carries the lease length and the poll path |
| `POST /daemon/heartbeat` | keep the lease alive; cloud marks the device online while leases keep arriving |
| `GET /daemon/poll?wait=25` | long-poll: `204` when nothing is queued, otherwise one assignment `{assignmentId, ticketId, brief, workdir, deadline}` |
| `POST /daemon/result` | `{assignmentId, status: 'done'｜'failed'｜'blocked', text, usage?}` |
| `POST /daemon/progress` | optional: nudge/abort notices and the watchdog verdicts the device saw |

Semantics:

- **Lease, not lock.** An assignment handed to a device is leased for `leaseMs` (default 60s) and
  renewed by heartbeats. If the device disappears, the lease expires and the assignment goes back to
  the queue — the cloud never waits forever on a laptop that closed its lid.
- **One at a time per device** by default; the register call may ask for more, the cloud caps it.
- **Idempotent results.** `assignmentId` is unique; a repeated result is accepted and ignored, so a
  daemon that retries after a network blip cannot double-post a reply.
- **The brief is already spilled.** The daemon receives the same inline/spill brief the local worker
  would get (ids plus a bounded body); it can ask the cloud for `recall` expansions over the same
  token instead of receiving whole transcripts.
- **Tools stay local.** `bash`, file edits and the working tree never leave the device; only the
  brief goes out and only the result comes back.

## Trust boundaries

- The daemon is **not** trusted with the queue: it receives work, it cannot create tickets, assign,
  stop or close anything.
- Model credentials live only in the daemon's environment; the cloud never stores or forwards them.
- The token is scoped to the device; revoking it stops new assignments at once and the in-flight
  lease simply expires.
- A device's result is untrusted input like any other worker output: the cloud still validates the
  reply length, the ticket state and the outbox rules before anything reaches a person.

## What the first cut is not

- No daemon-side UI, no local session console.
- No multi-device load balancing beyond "lease the next free device"; no affinity by workdir.
- No end-to-end encryption of the brief beyond TLS; a self-hosted daemon should point at the tunnel.

## Rollout

Feature-flagged: `SUP_DAEMON=off` (default) keeps today's local worker exactly as is. With `on`, a
worker task checks for a leased device first and falls back to the local executor if none is online,
so a dead laptop degrades to the current behaviour instead of stalling the queue.
