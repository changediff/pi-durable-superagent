# Watchdog (turn supervision)

A worker turn is one long `submission.wait`: from the outside a model that is looping or drifting looks
exactly like a model that is working. Before this the only backstop was `SUP_TURN_TIMEOUT_MS`
(30 minutes). The watchdog is the missing judge — an independent session that samples the running
worker and decides whether it is actually making progress.

It is not a heartbeat. A heartbeat asks "is the process alive"; the watchdog asks "is this turn going
anywhere", which needs a model and the worker's own transcript.

## What one check does

Every `intervalMs`, while the turn is in flight:

1. read the worker conversation's recent activity (last lines) and its newest entry id;
2. the tail moving since the previous sample counts as activity, so `idleMs` is "time since the
   transcript actually changed", not "time since the turn started";
3. ask the watchdog's **own** conversation for a verdict:

| Verdict | Meaning | Action in `auto` |
|---|---|---|
| `advancing` | new tool calls, new results, real movement toward the ticket | none (clears the last problem) |
| `stalled` | little or nothing happened for a while | nudge, then abort on a repeat |
| `looping` | still moving, but repeating the same command/step without new results | nudge, then abort on a repeat |
| `drifting` | still moving, but away from the ticket's goal | nudge, then abort on a repeat |

A nudge is injected through the worker's normal `deliver()` channel and names the problem
(`【看护提示】…`), asks the worker to state a different approach before continuing, and tells it to
report `blocked`/`failed` if it cannot proceed. It is never a bare "继续".

Abort rules: the same problem twice in a row → abort; or the intervention budget
(`maxInterventions`, default 2) is spent → abort. An abort ends the turn, `handle.abort()` is called
and the runner reports `failed` with `执行失败：watchdog 判定卡死（…）`, so the ticket shows a real
failure instead of hanging until the timeout.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `SUP_WATCHDOG` | `off` | `off` never samples; `observe` records verdicts only; `auto` nudges and aborts |
| `SUP_WATCHDOG_INTERVAL_MS` | `120000` | sample cadence |
| `SUP_WATCHDOG_MODEL` | worker model | model id; the provider always follows the worker's |
| `SUP_WATCHDOG_MAX_INTERVENTIONS` | `2` | nudges per turn before aborting |

Roll it out with `observe` first: every verdict is logged and stored, nothing is injected, so the
judgements can be read against what the worker actually did before letting it touch a turn.

## Observability

- Log line per completed check:
  `watchdog {ticketId, verdict, reason, interventions}`
- Full history (verdict, reason, action, idleMs, at) is kept per ticket in the store under the
  watchdog key, capped at the last entries — enough to answer "was this turn stuck, and what did the
  judge see" after the fact.
- A failed judgement call logs `watchdog check failed` and the loop simply continues: a watchdog that
  cannot think must never break the turn it watches.

## Boundaries

- The watchdog is **not** durable work of its own: its timer lives inside the worker task's
  invocation and is `unref`'d, so a restart never leaves a stray loop, and the durable queue still
  sees exactly one task per ticket.
- It never creates tickets or assignments; it only observes one turn, nudges it, or ends it.
- Its conversation is separate from the worker's (`watchdog:<ticketId>`), so its reasoning does not
  pollute the worker's context and its token cost is per check, not per turn.
- Being an ordinary session, it can later be given tools and asked questions directly — that is the
  design's "let the maintainer interrogate the watchdog" property, not implemented yet.
