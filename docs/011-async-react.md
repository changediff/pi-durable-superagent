# Async ReAct (`start` / `stop`)

Every tool call before this was synchronous: a `bash` command that takes ten minutes keeps the
conversation from reading a single new message until it returns. The design's 4.1 section calls for a
full-duplex loop instead — the model launches the long thing, gets an immediate acknowledgement, and
keeps talking while it runs (`src/plugin/react.ts`).

## The tool pair

| Tool | Returns | What happens after |
|---|---|---|
| `start({ command, cwd?, timeout_ms? })` | `{ id, status: 'started', pid }` — immediately | the command runs detached in its own process group; on exit its result is delivered back into the **same conversation** as a new input message |
| `stop({ id })` | `{ id, status: 'stopped' }` once the process is reaped (≤2s) | whole process group killed; an unknown id is an error listing the jobs this conversation has |
| `list()` | `{ jobs: [{ id, pid, elapsedMs, command }] }` | read-only |

The delivered message looks like:

```
[后台任务完成] <command>
exit=<code> elapsed=<seconds>s
--- stdout ---
…
--- stderr ---
…
```

It arrives as an ordinary input, so the model reacts to it in a later turn of the same conversation —
there is no separate "poll for result" tool to learn.

## Bounds

- **4 jobs per conversation.** The fifth `start` fails with an explanation instead of piling up shells.
- **`timeout_ms` 10 minutes by default.** On timeout the group is killed and the message says `timed out`.
- **Bounded capture.** stdout and stderr each keep the first 4 KiB and the last 2 KiB, with
  `… truncated N bytes …` in the middle — a command that prints 200 MB cannot flood the context.
- **Cleanup follows the session.** Whoever ends a conversation disposes the jobs it left running: the
  worker's abort paths (domain stop, timeout, watchdog abort) and runtime shutdown. A normal turn that
  finishes keeps its conversation, so its jobs keep reporting.
- **Delivery is best effort.** If the conversation is gone or the submit is rejected, the failure is
  logged and swallowed; a background result can never crash the process that produced it.

## What this does and does not change

- `bash` still exists and still blocks — the pair is additive. Short commands stay where they are;
  `start` is for the ones the model would otherwise sit through.
- These tools are installed on the shared registry, so the Router and Workers both have them. The
  Router is the main beneficiary: it must stay responsive to new messages while work runs.
- The job table is process memory: a container restart loses the handles (and the OS reaps its
  children). That is intentional — background jobs are episode state, not durable queue state; the
  durable Task still owns everything that must survive a restart.
