/**
 * The async ReAct loop (design doc §4.1): long-running shell commands become background jobs.
 *
 * `start` returns at once ({id, status:'started', pid}) — the conversation keeps processing new
 * input while the command runs detached in its own process group. When it exits, a watcher
 * delivers the result (command, exit code, duration, truncated stdout/stderr) back into the
 * conversation that started it as a *new input message*, so the model reacts to it in a later
 * turn. `stop` kills a job (its whole process group) on demand, `list` shows this conversation's
 * running jobs, and whoever ends a session cleans up the jobs it left running (the worker task
 * aborts, the runtime stops). OS children are process-global, so one process-wide
 * `backgroundJobs` table backs every conversation's tools and the session-end cleanups alike.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord/context'
import { defineExtension, defineTool, section } from '@earendil-works/pi-durable'
import type { Extension, ToolExecutionApi } from '@earendil-works/pi-durable'
import { int, num, obj, opt, str } from '@earendil-works/pi-schema'
import { liveTicket, threadKey, type Thread, type Ticket, type Trigger } from '../core/index.ts'
import { KV, type Key } from '../kv.ts'

/** How many background tasks one conversation may run at the same time. */
export const REACT_MAX_PER_SESSION = 4
/** Default `timeout_ms` of a background task: 10 minutes. */
export const REACT_DEFAULT_TIMEOUT_MS = 10 * 60_000
/** stdout/stderr are delivered as the first 4 KiB plus the last 2 KiB, with the middle summarised. */
const STREAM_HEAD_BYTES = 4096
const STREAM_TAIL_BYTES = 2048
/** How long `stop` waits for the killed process to be reaped before answering anyway. */
const STOP_WAIT_MS = 2000

/** The session surface delivery needs: submit one new input message into the conversation. */
export interface ReactSession {
  submit(submission: { readonly type: 'input'; readonly content: string; readonly requestId?: string; readonly whenBusy?: 'steer' | 'followUp' | 'reject' }, context: Context): Promise<unknown>
}

/** The ticket that owns a worker conversation, as the durable reverse index records it. */
export const reactOwnerKey = (conversationId: string) => KV.react.owner(conversationId)

/** Read a worker conversation's owning ticket from the durable reverse index (written when the worker uses it). */
export const ticketOfConversation = (store: { get<V>(key: Key<V>): V | undefined }, conversationId: string): string | undefined =>
  store.get(KV.react.owner(conversationId))

/** A finished background job's result, after it was successfully submitted into its conversation. */
export interface ReactResultInput {
  jobId: string
  conversationId: string
  /** The ticket that owns the conversation, when the durable reverse index knows it. */
  ticketId?: string
  content: string
}

export interface ReactDeps {
  /** Resolve the conversation that owns a job, to deliver its result as a new input message. */
  session(id: string): Promise<ReactSession | undefined>
  /** Resolve the ticket that owns a conversation, so the result can re-enter the event flow if it has ended. */
  ticketOf?(conversationId: string): string | undefined
  /** Called after a result was successfully submitted into its conversation; failures never affect delivery. */
  onResult?(input: ReactResultInput): void
  /** Job table to install; defaults to the process-wide `backgroundJobs`, which it binds to `session`. */
  jobs?: BackgroundJobs
  log?(message: string, detail?: unknown): void
}

/** Bounded stream capture: the first `head` bytes and the last `tail` bytes, the middle summarised. */
class HeadTail {
  private head: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private tail: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  private bytes = 0

  constructor(private readonly headLimit: number, private readonly tailLimit: number) {}

  push(chunk: Buffer): void {
    this.bytes += chunk.length
    if (this.head.length < this.headLimit) {
      this.head = Buffer.concat([this.head, chunk.subarray(0, this.headLimit - this.head.length)])
    }
    this.tail = chunk.length >= this.tailLimit
      ? chunk.subarray(chunk.length - this.tailLimit)
      : Buffer.concat([this.tail, chunk]).subarray(-this.tailLimit)
  }

  /** The kept text; `… truncated N bytes …` replaces whatever the limits dropped. */
  render(): string {
    const overlap = this.head.length + this.tail.length - this.bytes
    if (overlap >= 0) {
      // Nothing was dropped; where head and tail meet, the tail repeats the head's last bytes.
      return Buffer.concat([this.head, this.tail.subarray(overlap)]).toString('utf8')
    }
    const omitted = -overlap
    return `${this.head.toString('utf8')}\n… truncated ${omitted} bytes …\n${this.tail.toString('utf8')}`
  }
}

type JobEnding =
  | { readonly kind: 'exit'; readonly code: number | null; readonly signal: string | null }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'timeout'; readonly limitMs: number }
  | { readonly kind: 'spawn-error'; readonly message: string }

interface Job {
  readonly id: string
  readonly conversationId: string
  readonly command: string
  readonly cwd: string
  readonly pid: number
  readonly startedAt: number
  readonly child: ChildProcess
  readonly stdout: HeadTail
  readonly stderr: HeadTail
  ending: JobEnding | null
  ended: boolean
  discarded: boolean
  timer: ReturnType<typeof setTimeout> | undefined
}

/** What `list` reports about one running job. */
export interface JobView {
  readonly id: string
  readonly pid: number
  readonly command: string
  readonly startedAt: number
}

export interface BackgroundJobsDeps {
  session(id: string): Promise<ReactSession | undefined>
  ticketOf?(conversationId: string): string | undefined
  onResult?(input: ReactResultInput): void
  log(message: string, detail?: unknown): void
}

/**
 * The background job table: spawn detached process groups, enforce the per-session cap, kill on
 * stop/timeout/session-end, and deliver each finished job's result back into its conversation.
 */
export class BackgroundJobs {
  private readonly byId = new Map<string, Job>()
  private readonly byConversation = new Map<string, Set<string>>()
  /** Deliveries in flight per conversation: a result submitted but not yet placed is not settled. */
  private readonly deliveries = new Map<string, number>()
  private readonly settledWaiters = new Map<string, Set<() => void>>()
  private counter = 0
  private deps: BackgroundJobsDeps | undefined

  /** Late-bind delivery (the host knows the harness only after the registry is built). */
  bind(deps: BackgroundJobsDeps): this {
    this.deps = deps
    return this
  }

  /** One conversation's running jobs, oldest first. */
  jobsOf(conversationId: string): JobView[] {
    const ids = this.byConversation.get(conversationId)
    if (!ids) return []
    return [...ids].map(id => this.byId.get(id)).filter((job): job is Job => !!job)
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(job => ({ id: job.id, pid: job.pid, command: job.command, startedAt: job.startedAt }))
  }

  /**
   * Resolve once the conversation runs no background job and every finished job's result has been
   * submitted into it (a failed delivery counts as settled — it will never arrive). `signal` releases
   * the waiter early, so a caller can enforce its own deadline without polling. Never rejects.
   */
  waitForSettled(conversationId: string, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted || this.isSettled(conversationId)) return Promise.resolve()
    return new Promise(resolve => {
      let waiters = this.settledWaiters.get(conversationId)
      if (!waiters) {
        waiters = new Set()
        this.settledWaiters.set(conversationId, waiters)
      }
      const done = () => {
        const current = this.settledWaiters.get(conversationId)
        current?.delete(done)
        if (current && !current.size) this.settledWaiters.delete(conversationId)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      waiters.add(done)
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  /** Whether a conversation has neither a running job nor a result delivery still being submitted. */
  private isSettled(conversationId: string): boolean {
    return !this.byConversation.has(conversationId) && !this.deliveries.has(conversationId)
  }

  /** Resolve the waiters once nothing is left to finish or deliver there. */
  private notifySettled(conversationId: string): void {
    if (!this.isSettled(conversationId)) return
    const waiters = this.settledWaiters.get(conversationId)
    if (!waiters) return
    this.settledWaiters.delete(conversationId)
    for (const done of waiters) done()
  }

  /** Track one result delivery in flight; a zero count is no delivery. */
  private countDelivery(conversationId: string, delta: 1 | -1): void {
    const count = (this.deliveries.get(conversationId) ?? 0) + delta
    if (count > 0) this.deliveries.set(conversationId, count)
    else this.deliveries.delete(conversationId)
  }

  /** Spawn a detached process group and return at once; the result is delivered on exit. */
  launch(conversationId: string, request: { command: string; cwd: string; timeoutMs: number }): { ok: true; id: string; pid: number } | { ok: false; error: string } {
    const running = this.jobsOf(conversationId)
    if (running.length >= REACT_MAX_PER_SESSION) {
      const ids = running.map(job => job.id).join(', ')
      return { ok: false, error: `this conversation already runs ${running.length} background tasks (cap ${REACT_MAX_PER_SESSION}: ${ids}); wait for one to finish or stop one first` }
    }
    try {
      if (!statSync(request.cwd).isDirectory()) return { ok: false, error: `cwd is not a directory: ${request.cwd}` }
    } catch {
      return { ok: false, error: `cwd does not exist: ${request.cwd}` }
    }
    const id = `bg-${++this.counter}`
    let child: ChildProcess
    try {
      child = spawn('/bin/sh', ['-c', request.command], { detached: true, cwd: request.cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      return { ok: false, error: `spawn failed: ${String((error as Error)?.message ?? error)}` }
    }
    if (child.pid === undefined) return { ok: false, error: 'spawn failed: no pid' }
    const job: Job = {
      id, conversationId, command: request.command, cwd: request.cwd, pid: child.pid, startedAt: Date.now(), child,
      stdout: new HeadTail(STREAM_HEAD_BYTES, STREAM_TAIL_BYTES),
      stderr: new HeadTail(STREAM_HEAD_BYTES, STREAM_TAIL_BYTES),
      ending: null, ended: false, discarded: false, timer: undefined,
    }
    this.byId.set(id, job)
    this.conversationJobs(conversationId).add(id)
    child.stdout?.on('data', (chunk: Buffer) => job.stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => job.stderr.push(chunk))
    child.on('error', error => {
      job.ending ??= { kind: 'spawn-error', message: String((error as Error)?.message ?? error) }
      this.finish(job)
    })
    child.on('close', (code, signal) => {
      job.ending ??= { kind: 'exit', code, signal }
      this.finish(job)
    })
    job.timer = setTimeout(() => {
      job.ending ??= { kind: 'timeout', limitMs: request.timeoutMs }
      killGroup(child)
    }, request.timeoutMs)
    job.timer.unref?.()
    return { ok: true, id, pid: child.pid }
  }

  /** Kill a job of this conversation (its whole process group); resolves once the process is gone. */
  async stop(id: string, conversationId: string): Promise<{ ok: true; id: string } | { ok: false; error: string; running: readonly string[] }> {
    const job = this.byId.get(id)
    if (!job || job.conversationId !== conversationId) {
      return { ok: false, error: `unknown background task id "${id}" in this conversation`, running: this.jobsOf(conversationId).map(view => view.id) }
    }
    job.ending ??= { kind: 'stopped' }
    killGroup(job.child)
    await exited(job.child)
    return { ok: true, id }
  }

  /** End of session: kill whatever it left running, without delivering results anywhere. */
  dispose(conversationId: string): void {
    for (const id of [...this.conversationJobs(conversationId)]) {
      const job = this.byId.get(id)
      if (job) this.drop(job, true)
    }
  }

  /** End of process: kill every job of every conversation. */
  disposeAll(): void {
    for (const id of [...this.byId.keys()]) {
      const job = this.byId.get(id)
      if (job) this.drop(job, true)
    }
  }

  private conversationJobs(conversationId: string): Set<string> {
    let jobs = this.byConversation.get(conversationId)
    if (!jobs) {
      jobs = new Set()
      this.byConversation.set(conversationId, jobs)
    }
    return jobs
  }

  /** Remove a job, optionally discarding its result; idempotent. */
  private finish(job: Job): void {
    if (job.ended) return
    job.ended = true
    if (job.timer) clearTimeout(job.timer)
    // Count the delivery before dropping the job, so a waiter never sees the conversation settled
    // between the job leaving the table and its result being submitted.
    if (!job.discarded) this.countDelivery(job.conversationId, 1)
    this.drop(job, job.discarded)
    if (job.discarded) return
    void this.deliver(job).finally(() => {
      this.countDelivery(job.conversationId, -1)
      this.notifySettled(job.conversationId)
    })
  }

  private drop(job: Job, discard: boolean): void {
    if (discard) job.discarded = true
    if (job.timer) clearTimeout(job.timer)
    this.byId.delete(job.id)
    const jobs = this.byConversation.get(job.conversationId)
    jobs?.delete(job.id)
    if (jobs && !jobs.size) this.byConversation.delete(job.conversationId)
    if (discard) killGroup(job.child)
    this.notifySettled(job.conversationId)
  }

  /** Deliver the finished job's result as a new input message; a gone or aborted conversation fails quietly. */
  private async deliver(job: Job): Promise<void> {
    const deps = this.deps
    if (!deps) return
    const content = resultMessage(job)
    try {
      const session = await deps.session(job.conversationId)
      if (!session) {
        deps.log('react result dropped', `${job.id}: conversation ${job.conversationId} is gone`)
        return
      }
      await session.submit({ type: 'input', content, requestId: `react:${job.id}`, whenBusy: 'followUp' }, BACKGROUND_CONTEXT)
      deps.log('react result delivered', `${job.id} -> ${job.conversationId}`)
      // The result is in the conversation now. A live ticket's turn will read it; an ended ticket needs
      // the host's hook to put it back into the event flow. A hook failure must not undo the delivery.
      try {
        deps.onResult?.({ jobId: job.id, conversationId: job.conversationId, ticketId: deps.ticketOf?.(job.conversationId), content })
      } catch (error) {
        deps.log('react result hook failed', `${job.id}: ${String((error as Error)?.message ?? error)}`)
      }
    } catch (error) {
      // The session may have ended or been aborted between start and exit; never crash the host.
      deps.log('react result delivery failed', `${job.id}: ${String((error as Error)?.message ?? error)}`)
    }
  }
}

export interface ReactResultRequeueDeps {
  /** The ticket the reverse index named, or undefined when it is unknown. */
  ticket(id: string): Ticket | undefined
  /** Every stored Thread, to find the one the ticket subscribed to. */
  threads(): Thread[]
  /** A previously stored Trigger, which makes repeated deliveries of one job idempotent. */
  trigger(id: string): Trigger | undefined
  /** The domain Engine's intake path (`Engine.receive`). */
  receive(trigger: Trigger): unknown
  log(message: string, detail?: unknown): void
  now?(): string
}

/**
 * The delivery hook: when a background result reached a conversation whose ticket has ended, submit the
 * result to the domain as a new environment event. A live ticket needs nothing — its turn reads the
 * message. The event is not human: an Eval decides whether the ended ticket should resume.
 */
export function requeueReactResult(deps: ReactResultRequeueDeps, input: ReactResultInput): void {
  try {
    const ticketId = input.ticketId
    if (!ticketId) return
    const ticket = deps.ticket(ticketId)
    if (!ticket) {
      deps.log('react result ignored', { jobId: input.jobId, ticketId })
      return
    }
    // The turn that is still running (or waiting for its next wake) will read the submitted message.
    if (liveTicket(ticket)) return
    const triggerId = `react:${input.jobId}`
    if (deps.trigger(triggerId)) {
      deps.log('react result ignored', { jobId: input.jobId, ticketId })
      return
    }
    const threads = deps.threads()
    const thread = threads.find(item => item.subscriptions.includes(ticket.id) && !item.context?.includes(ticket.id))
      ?? threads.find(item => item.subscriptions.includes(ticket.id))
    if (!thread) {
      deps.log('react result ignored', { jobId: input.jobId, ticketId, reason: 'no subscribed thread' })
      return
    }
    const trigger: Trigger = {
      id: triggerId,
      source: 'react',
      threads: [thread.ref],
      // Senderless, like a CI event: the gate admits system events as inferred, never as a person's request.
      actor: { source: 'react', id: '' },
      human: false,
      at: deps.now?.() ?? new Date().toISOString(),
      text: input.content,
      meta: { jobId: input.jobId, conversationId: input.conversationId, ticketId: ticket.id, background: true },
    }
    deps.receive(trigger)
    deps.log('react result requeued', { jobId: input.jobId, triggerId, thread: threadKey(thread.ref) })
  } catch (error) {
    // A ticket or Thread may have changed between delivery and this lookup; never crash the host.
    deps.log('react result requeue failed', `${input.jobId}: ${String((error as Error)?.message ?? error)}`)
  }
}

/** SIGKILL the whole detached process group (negative pid), then the child itself; ESRCH is fine. */
function killGroup(child: ChildProcess): void {
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGKILL') } catch { /* group already gone */ }
    try { child.kill('SIGKILL') } catch { /* child already gone */ }
  }
}

/** Resolve when the child has exited (so it is reaped), or after `limitMs` at the latest. */
function exited(child: ChildProcess, limitMs = STOP_WAIT_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); resolve() }
    const timer = setTimeout(() => { child.off('exit', done); resolve() }, limitMs)
    timer.unref?.()
    child.once('exit', done)
    child.once('error', done)
  })
}

/** The input message a finished job sends back into its conversation. */
function resultMessage(job: Job): string {
  const seconds = ((Date.now() - job.startedAt) / 1000).toFixed(1)
  const ending = job.ending ?? { kind: 'exit' as const, code: null, signal: null }
  const status = ending.kind === 'stopped'
    ? 'status=stopped（被 stop 终止）'
    : ending.kind === 'timeout'
      ? `status=timed out（超过 ${ending.limitMs}ms 上限，已被终止）`
      : ending.kind === 'spawn-error'
        ? `status=failed（启动失败：${ending.message}）`
        : `status=exited exit=${ending.code ?? 'null'}${ending.signal ? ` signal=${ending.signal}` : ''}`
  return [
    `[后台任务 ${job.id} 已结束] ${status} 耗时=${seconds}s`,
    `命令: ${job.command}`,
    '--- stdout ---',
    job.stdout.render() || '(无输出)',
    '--- stderr ---',
    job.stderr.render() || '(无输出)',
  ].join('\n')
}

/** The process-wide job table: OS children outlive tool calls, so every conversation shares one. */
export const backgroundJobs = new BackgroundJobs()

/** The prompt section that documents the async ReAct surface. */
export const REACT_SECTION = `Long commands do not have to block this conversation.
- start: run a shell command in the background; it returns immediately with {id, status:"started", pid}, and when the command exits its result (command, exit code, duration, truncated stdout/stderr) arrives here as a new input message — keep working, then react to that message.
- stop: kill one of this conversation's background tasks (its whole process group) by id.
- list: the background tasks this conversation is currently running.
At most 4 background tasks run per conversation at once; each is killed after timeout_ms (default 10 minutes).`

export type ReactExtension = Extension & { readonly jobs: BackgroundJobs }

/** Build the react extension (start/stop/list) against one job table. */
export function createReactExtension(deps: ReactDeps): ReactExtension {
  const log = deps.log ?? (() => {})
  const jobs = (deps.jobs ?? backgroundJobs).bind({ session: deps.session, ticketOf: deps.ticketOf, onResult: deps.onResult, log })
  const conversationOf = (api: ToolExecutionApi<never>): string => String(api.conversationId)

  const start = defineTool({
    name: 'start',
    description: 'Run a shell command in the background and return at once ({id, status:"started", pid}). Its final result (command, exit code, duration, truncated stdout/stderr) is delivered back into this conversation as a new input message when it exits. Use this instead of bash for anything slow.',
    parameters: obj({
      command: str({ description: 'The shell command, run via /bin/sh -c' }),
      cwd: opt(str({ description: 'Working directory; defaults to the session working directory' })),
      timeout_ms: opt(int({ minimum: 100, description: 'Kill the job after this many milliseconds; default 600000 (10 minutes)' })),
    }),
    structuredOutputSchema: obj({ id: str(), status: str(), pid: num() }),
    execute: async (args, api: ToolExecutionApi<never>) => {
      const cwd = args.cwd ?? api.env?.cwd ?? process.cwd()
      const launched = jobs.launch(conversationOf(api), { command: args.command, cwd, timeoutMs: args.timeout_ms ?? REACT_DEFAULT_TIMEOUT_MS })
      if (!launched.ok) return { isError: true, output: [{ type: 'text', text: `start: ${launched.error}` }] }
      return {
        output: [{ type: 'text', text: `Background task ${launched.id} started (pid ${launched.pid}). Its result arrives here as a new message when it exits; kill it early with stop({ id: "${launched.id}" }).` }],
        structuredOutput: { id: launched.id, status: 'started', pid: launched.pid },
      }
    },
  })

  const stop = defineTool({
    name: 'stop',
    description: 'Kill one of this conversation\'s background tasks (its whole process group) by id, returning {id, status:"stopped"}.',
    parameters: obj({
      id: str({ description: 'The task id `start` returned' }),
    }),
    structuredOutputSchema: obj({ id: str(), status: str() }),
    execute: async (args, api: ToolExecutionApi<never>) => {
      const stopped = await jobs.stop(args.id, conversationOf(api))
      if (!stopped.ok) {
        const running = stopped.running.length ? stopped.running.join(', ') : '(none)'
        return { isError: true, output: [{ type: 'text', text: `stop: ${stopped.error}; running here: ${running}` }] }
      }
      return {
        output: [{ type: 'text', text: `Background task ${args.id} stopped.` }],
        structuredOutput: { id: args.id, status: 'stopped' },
      }
    },
  })

  const list = defineTool({
    name: 'list',
    description: 'List the background tasks this conversation is currently running (id, pid, elapsed, command).',
    parameters: obj({}),
    execute: async (_args, api: ToolExecutionApi<never>) => {
      const running = jobs.jobsOf(conversationOf(api))
      if (!running.length) return { output: [{ type: 'text', text: 'No background tasks running in this conversation.' }] }
      const lines = running.map(job => `${job.id} pid=${job.pid} ${Math.round((Date.now() - job.startedAt) / 1000)}s: ${job.command}`)
      return { output: [{ type: 'text', text: lines.join('\n') }] }
    },
  })

  return Object.assign(
    defineExtension({ name: 'react', tools: [start, stop, list], sections: [section('react', () => REACT_SECTION, { tag: true })] }),
    { jobs },
  )
}
