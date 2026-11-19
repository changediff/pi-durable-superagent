/**
 * The watchdog over a whole worker turn, not just the first model wait: after the model replies the
 * worker may sit in `awaitBackgroundJobs` for a long time, and that wait is exactly when a stuck
 * command or a silent loop needs judging. These tests drive `createWorkerTask` with a fake clock,
 * fake conversations (worker + watchdog) and a fake job table — zero network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EntryRecord } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import type { Engine, Ticket } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { resolveSuperagentConfig, type WatchdogMode } from '../src/plugin/config.ts'
import type { JobView } from '../src/plugin/react.ts'
import {
  createWorkerTask, workerConversationKey, type RunningWorker, type WorkerBackgroundJobs, type WorkerRuntime,
} from '../src/plugin/worker.ts'
import type { WatchdogVerdictKind } from '../src/plugin/watchdog.ts'
import type { Store } from '../src/app/store.ts'

const TICKET = 't-1'
const ASSIGNMENT = 'a-1'
const WORKER_CONVERSATION = 226
const WATCHDOG_CONVERSATION = 900
const INTERVAL = 1_000
const CONTEXT = {} as Context

/** Drain the promise chain of one synchronous fake-io step (no real waits involved). */
const flush = async (): Promise<void> => { for (let i = 0; i < 40; i++) await Promise.resolve() }

const assistantEntry = (text: string, id: number): EntryRecord =>
  ({ id, kind: 'pi.assistant', model: [{ content: [{ type: 'text', text }] }] }) as unknown as EntryRecord

/** The worker's conversation: each submit starts a model run, which the test ends. */
class FakeWorkerConversation {
  readonly id = WORKER_CONVERSATION
  readonly submissions: string[] = []
  readonly modelInputs: string[][] = []
  assistantText = ''
  private context: string[] = []
  private current: (() => void) | undefined
  private idleWaiters: (() => void)[] = []

  async submit(draft: { content: string; whenIdle?: 'reject' }): Promise<unknown> {
    this.submissions.push(draft.content)
    this.context.push(draft.content)
    const done = this.startRun()
    return {
      id: this.submissions.length,
      wait: async (): Promise<{ status: string; type: string }> => {
        await done
        return { status: 'done', type: 'input' }
      },
    }
  }

  /** A finished background job's result reaches the conversation as a new input, starting its run. */
  deliverResult(content: string): void {
    this.context.push(content)
    this.startRun()
  }

  endRun(text?: string): void {
    if (text !== undefined) this.assistantText = text
    const end = this.current
    this.current = undefined
    end?.()
    for (const resolve of this.idleWaiters.splice(0)) resolve()
  }

  waitForIdle(): Promise<void> {
    if (!this.current) return Promise.resolve()
    return new Promise(resolve => { this.idleWaiters.push(resolve) })
  }

  async abort(): Promise<void> {
    this.endRun()
  }

  private startRun(): Promise<void> {
    let end!: () => void
    const done = new Promise<void>(resolve => { end = resolve })
    this.current = end
    this.idleWaiters = []
    this.modelInputs.push([...this.context])
    return done
  }
}

/** The watchdog's own conversation: each submit is one judgement, answered from a script at once. */
class FakeWatchdogConversation {
  readonly id = WATCHDOG_CONVERSATION
  readonly prompts: string[] = []
  assistantText = ''
  private readonly script: WatchdogVerdictKind[]

  constructor(script: WatchdogVerdictKind[]) { this.script = [...script] }

  async submit(draft: { content: string }): Promise<unknown> {
    this.prompts.push(draft.content)
    const next = this.script.shift()
    this.assistantText = next ? JSON.stringify({ verdict: next, reason: '测试判定' }) : ''
    return { wait: async (): Promise<{ status: string; type: string }> => ({ status: 'done', type: 'input' }) }
  }

  async abort(): Promise<void> {}
}

/** A fake background-job table: jobs end when the test says so; a finish may deliver its result first. */
class FakeJobs implements WorkerBackgroundJobs {
  readonly waits: string[] = []
  onFinish?: (job: JobView) => void
  private readonly jobs = new Map<string, JobView>()
  private waiters: (() => void)[] = []

  jobsOf(_conversationId: string): readonly JobView[] {
    return [...this.jobs.values()]
  }

  waitForSettled(_conversationId: string, signal?: AbortSignal): Promise<void> {
    this.waits.push(_conversationId)
    if (!this.jobs.size) return Promise.resolve()
    return new Promise(resolve => {
      const done = (): void => { signal?.removeEventListener('abort', done); resolve() }
      signal?.addEventListener('abort', done, { once: true })
      this.waiters.push(done)
    })
  }

  add(id: string, command: string): void {
    this.jobs.set(id, { id, command, pid: 1, startedAt: Date.now() })
  }

  finish(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.jobs.delete(id)
    this.onFinish?.(job)
    if (this.jobs.size) return
    for (const done of this.waiters.splice(0)) done()
  }
}

interface Setup {
  readonly worker: FakeWorkerConversation
  readonly judge: FakeWatchdogConversation
  readonly jobs: FakeJobs
  readonly store: Store
  readonly report: ReturnType<typeof vi.fn>
  readonly reply: ReturnType<typeof vi.fn>
  readonly log: ReturnType<typeof vi.fn>
  readonly runningWorker: () => RunningWorker
  readonly run: () => Promise<void>
  readonly terminal: () => unknown
}

/** Build the worker task around fakes and return a driver for its single phase. */
const setup = (options: { mode?: WatchdogMode; script?: WatchdogVerdictKind[]; timeoutMs?: number } = {}): Setup => {
  const worker = new FakeWorkerConversation()
  const judge = new FakeWatchdogConversation(options.script ?? [])
  const jobs = new FakeJobs()
  const report = vi.fn()
  const reply = vi.fn()
  const log = vi.fn()
  const ticket = {
    id: TICKET, title: '测试工单', decisionId: 'd-1', mandate: { scope: '完成测试任务' },
    channels: [], assignments: [{ id: ASSIGNMENT, state: 'running', createdAt: '2026-01-01T00:00:00.000Z' }],
    inputs: [], undelivered: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    origin: { triggerId: 'tr-1', triggerIds: ['tr-1'] },
  } as unknown as Ticket
  const kv = new Map<string, unknown>([[workerConversationKey(TICKET), WORKER_CONVERSATION]])
  const store = {
    get: (key: string) => kv.get(key),
    set: (key: string, value: unknown) => { kv.set(key, value) },
    atomic: <T>(operation: () => T): T => operation(),
    tickets: { get: (id: string) => id === TICKET ? ticket : undefined, active: () => [], list: () => [ticket] },
    triggers: { get: () => undefined },
  } as unknown as Store
  const cfg = resolveSuperagentConfig({
    stateDir: '/tmp/watchdog-background-state',
    workDir: '/tmp/watchdog-background-work',
    harnessDir: '/tmp/watchdog-background-harness',
    maxWorkers: 1,
    evalMode: 'off',
    router: { provider: 'test', model: 'router' },
    worker: { provider: 'test', model: 'worker' },
    channel: { send: async () => 'sent' },
    watchdog: {
      mode: options.mode ?? 'auto', intervalMs: INTERVAL, maxInterventions: 2,
      model: { provider: 'test', model: 'watchdog' },
    },
    workerTurnTimeoutMs: options.timeoutMs ?? 60_000,
    log,
  })

  let terminal: unknown
  let registered: RunningWorker | undefined
  const task = { id: 1, input: { ticketId: TICKET, assignmentId: ASSIGNMENT }, state: { phase: 'run', status: 'running' } }
  const runtime = {
    signal: new AbortController().signal,
    taskId: 1,
    now: () => Date.now(),
    conversation: async (id: unknown) =>
      id === WORKER_CONVERSATION ? worker : id === WATCHDOG_CONVERSATION ? judge : undefined,
    commit: async (change: (...args: unknown[]) => unknown) => {
      const tx = {
        doc: async () => ({}),
        createConversation: async () => ({ id: WATCHDOG_CONVERSATION }),
      }
      const next = await change(tx, task)
      if (next !== undefined) terminal = next
    },
    context: async (id: unknown) => {
      if (id === WORKER_CONVERSATION && worker.assistantText) {
        return { entries: [assistantEntry(worker.assistantText, 1)] }
      }
      if (id === WATCHDOG_CONVERSATION && judge.assistantText) {
        return { entries: [assistantEntry(judge.assistantText, 2)] }
      }
      return { entries: [] }
    },
  } as unknown as WorkerRuntime

  const definition = createWorkerTask({
    store, cfg, jobs,
    bridges: {
      register: (running: RunningWorker) => { registered = running },
      release: () => {},
      get: () => undefined,
    } as never,
    engine: () => ({ report, reply } as unknown as Engine),
  })
  return {
    worker, judge, jobs, store, report, reply, log,
    runningWorker: () => registered!,
    terminal: () => terminal,
    run: async () => {
      const phase = definition.definition.phases.run as unknown as
        (task: unknown, runtime: unknown, context: Context) => Promise<void>
      await phase(task, runtime, CONTEXT)
    },
  }
}

const reportedSummary = (report: ReturnType<typeof vi.fn>): string =>
  (report.mock.calls.at(-1)?.[1] as { summary: string }).summary

/** End the brief's run and let the worker reach its background wait. */
const reachBackgroundWait = async (test: Setup): Promise<void> => {
  await flush()
  expect(test.worker.modelInputs).toHaveLength(1)
  test.worker.endRun('第一轮先回复')
  await flush()
  expect(test.jobs.waits).toHaveLength(1)
}

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('watchdog over the whole worker turn', () => {
  it('keeps judging during the background wait, and the worker finishes only after the job', async () => {
    const test = setup({ script: ['advancing', 'advancing'] })
    test.jobs.add('bg-1', 'sleep 40')
    const running = test.run()
    await reachBackgroundWait(test)
    expect(test.report).not.toHaveBeenCalled()

    // The model already replied; these two samples land entirely inside the background wait.
    await vi.advanceTimersByTimeAsync(2 * INTERVAL)
    await flush()
    expect(test.judge.prompts).toHaveLength(2)
    expect(test.judge.prompts[0]).toContain('工单目标：完成测试任务')
    const records = test.store.get(KV.watchdog.verdicts(TICKET))!
    expect(records).toHaveLength(2)
    expect(records.map(record => record.verdict)).toEqual(['advancing', 'advancing'])
    expect(test.report).not.toHaveBeenCalled()

    test.jobs.finish('bg-1')
    await running
    expect(test.report).toHaveBeenCalledTimes(1)
    expect(reportedSummary(test.report)).toBe('第一轮先回复')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('observe mode records stalls during the background wait without nudging', async () => {
    const test = setup({ mode: 'observe', script: ['stalled', 'stalled'] })
    test.jobs.add('bg-1', 'sleep 40')
    const running = test.run()
    await reachBackgroundWait(test)

    await vi.advanceTimersByTimeAsync(2 * INTERVAL)
    await flush()
    const records = test.store.get(KV.watchdog.verdicts(TICKET))!
    expect(records).toHaveLength(2)
    expect(records.every(record => record.action === 'recorded' && record.interventions === 0)).toBe(true)
    expect(test.worker.submissions.some(text => text.includes('看护提示'))).toBe(false)
    expect(test.report).not.toHaveBeenCalled()

    test.jobs.finish('bg-1')
    await running
    expect(reportedSummary(test.report)).toBe('第一轮先回复')
  })

  it('auto mode nudges into the conversation, then aborts the turn on a second stall', async () => {
    const test = setup({ script: ['stalled', 'stalled'] })
    test.jobs.add('bg-1', 'sleep 40')
    const running = test.run()
    await reachBackgroundWait(test)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    await flush()
    expect(test.judge.prompts).toHaveLength(1)
    // The nudge went in through the worker's own input channel.
    expect(test.worker.submissions.some(text => text.includes('看护提示'))).toBe(true)
    expect(test.report).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(INTERVAL)
    await running
    const records = test.store.get(KV.watchdog.verdicts(TICKET))!
    expect(records.map(record => record.action)).toEqual(['nudge', 'abort'])
    expect(test.report).toHaveBeenCalledTimes(1)
    expect(reportedSummary(test.report)).toContain('watchdog 判定卡死')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('shares the intervention budget across a resumed round (no reset)', async () => {
    const test = setup({ script: ['stalled', 'stalled'] })
    test.jobs.add('bg-1', 'sleep 40')
    test.jobs.onFinish = job => test.worker.deliverResult(`[后台任务 ${job.id} 已结束]`)
    const running = test.run()
    await reachBackgroundWait(test)

    // First round (still in the background wait): the first stall is a nudge.
    await vi.advanceTimersByTimeAsync(INTERVAL)
    await flush()
    expect(test.store.get(KV.watchdog.verdicts(TICKET))!.map(record => record.action)).toEqual(['nudge'])
    expect(test.worker.submissions.some(text => text.includes('看护提示'))).toBe(true)

    // The result starts a second (resumed) model run; the watchdog keeps its state.
    // (Three runs now: the brief, the nudge's own run, and the resumed result run.)
    test.jobs.finish('bg-1')
    await flush()
    expect(test.worker.modelInputs).toHaveLength(3)
    expect(test.worker.modelInputs[2]).toContain('[后台任务 bg-1 已结束]')

    await vi.advanceTimersByTimeAsync(INTERVAL)
    await running
    const records = test.store.get(KV.watchdog.verdicts(TICKET))!
    expect(records.map(record => record.action)).toEqual(['nudge', 'abort'])
    // The abort is the second intervention in the *same* turn, not a fresh first one.
    expect(records[1]!.interventions).toBe(1)
    expect(reportedSummary(test.report)).toContain('watchdog 判定卡死')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('an external stop ends the turn with no nudge and no dangling timer', async () => {
    // Advancing only: the one sample before the stop must never produce an intervention.
    const test = setup({ script: ['advancing', 'advancing'] })
    test.jobs.add('bg-1', 'sleep 40')
    const running = test.run()
    await reachBackgroundWait(test)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    await flush()
    expect(test.judge.prompts).toHaveLength(1)

    test.runningWorker().stop()
    await running
    expect(test.worker.submissions.some(text => text.includes('看护提示'))).toBe(false)
    expect(test.report).not.toHaveBeenCalled()
    expect(test.judge.prompts).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)

    // The worker's stop is idempotent: a second request changes nothing and starts no timer.
    test.runningWorker().stop()
    await vi.advanceTimersByTimeAsync(5 * INTERVAL)
    expect(test.judge.prompts).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a normal round without background jobs judges exactly as before and stops at the end', async () => {
    const test = setup({ script: ['advancing', 'advancing', 'advancing'] })
    const running = test.run()
    await flush()
    expect(test.worker.modelInputs).toHaveLength(1)
    expect(test.jobs.waits).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(INTERVAL)
    await flush()
    expect(test.judge.prompts).toHaveLength(1)

    test.worker.endRun('直接完成')
    await running
    expect(test.report).toHaveBeenCalledTimes(1)
    expect(reportedSummary(test.report)).toBe('直接完成')

    // No background wait means no extra samples after the turn ended.
    await vi.advanceTimersByTimeAsync(2 * INTERVAL)
    await flush()
    expect(test.judge.prompts).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
