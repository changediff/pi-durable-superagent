# Inline & Spill and chained recall

Design §3.3: treat the context window as a cache. **Inline** what the model will almost certainly
need; **Spill** everything else outside the window and leave a reference that can be pulled back on
demand. Give every object an id and inline the ids of its neighbours, and recall becomes a walk over a
reference graph instead of a transcript dump.

## Recall

`recall({ kind, id, cursor? })` — read-only, no model call, no store writes.

| kind | returns | `next` points at |
|---|---|---|
| `trigger` | summary + text (spilled) | its threads, the tickets its disposition fanned out to, the outbox message it produced |
| `thread` | subscription count, open/closed | the tickets on it (including ended ones), the last few triggers |
| `ticket` | mandate summary, state, ended how | its threads, its worker conversation, recent replies, the newest watchdog verdict, the trigger that started it |
| `conversation` | last ≤20 entries + total | its ticket |
| `outbox` | kind, state, text | the ticket and trigger behind it |

`next` entries are `{ kind, id, why }`, so a model that gets a Trigger can reach the Thread, the
Ticket, the worker conversation and the replies in a few hops without ever asking for "the whole
conversation".

**Spill format.** A field over 800 characters returns 600 head + 200 tail and
`… spilled N chars, recall with cursor …`. Passing that cursor returns the field in pages of at most
2000 characters with `nextCursor`; an empty `nextCursor` means the end. Concatenating the pages
reproduces the original text.

**Unknown ids.** The answer is an error that lists the five most recent ids of that kind — the model
gets a way forward instead of a dead end.

## Inline in the brief

The worker brief now tags every injected message:

```
[trigger:fs-om_123 thread:oc_abc:chat] 用户原话…
```

Content over 1200 characters is spilled into `head 800 + tail 300` plus
`recall({kind:'trigger', id:'fs-om_123'})`, so a long group thread costs a fixed slice of the window
and the model knows exactly how to read the rest. Short messages are untouched.

## Observability

- `recall {kind, id, bytes, spilled}` per call
- `brief spill {ticketId, triggerId, chars, kept}` when a brief is truncated

Both answer the question that matters for this feature: how much context the system is actually
spending, and on what.

## Limits

- The graph is only as complete as the store: an id that was never persisted (a job handle, a process
  id) cannot be recalled.
- `conversation` is capped: recent entries plus a count, never the full history.
- Cursors are offsets into the spilled field; if the underlying record changes between calls, a page
  can disagree with the original — acceptable for read-mostly history, not a snapshot guarantee.
