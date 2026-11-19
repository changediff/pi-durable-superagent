/**
 * Worker turns and background jobs: a turn that ends while its own `start` job still runs must not
 * finish the ticket. The worker waits for the job, lets the delivered result's run finish, and
 * re-checks — until no jobs run or the turn deadline is reached (then the result says so).
 *
 * Zero network and no real harness: a fake conversation handle and a fake job table drive
 * `createWorkerTask`'s phase function directly.
 */
import { describe, expect, it, vi } from 'vitest'
import type { EntryRecord } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import type { Engine, Ticket } from '../src/core/index.ts'
import { resolveSuperagentConfig } from '../src/plugin/config.ts'
import type { JobView } from '../src/plugin/react.ts'
import {
  createWorkerTask, workerConversationKey, type WorkerBackgroundJobs, type WorkerRuntime,
} from '../src/plugin/worker.ts'
import type { Store } from '../src/app/store.ts'

const TICKET = 't-1'
const ASSIGNMENT = 'a-1'
const CONVERSATION = 226
const CONTEXT = {} as Context

/** Let asynchronous work the worker started run to completion before probing again. */
const until = async (check: () => boolean, what: string, limitMs = 2000): Promise<void> => {
  const deadline = Date.now() + limitMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/**
 * A fake worker conversation. Every submit starts a model run (the test ends it), and a delivered
 * background result starts one too — exactly the followUp input react's delivery submits.
 */
class FakeConversation {
  readonly id = CONVERSATION
  readonly submissions: string[] = []
  /** The context each model run read, in run order. */
  readonly modelInputs: string[][] = []
  assistantText = ''
  private context: string[] = []
  private current: (() => void) | undefined
  private idleWaiters: (() => void)[] = []

  async submit(draft: { content: string }): Promise<unknown> {
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

  /** End the newest run, optionally with the assistant text it produced. */
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

  private startRun(): Promise<void> {
    let end!: () => void
    const done = new Promise<void>(resolve => { end = resolve })
    this.current = end
    this.idleWaiters = []
    this.modelInputs.push([...this.context])
    return done
  }
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

  /** One job ends; its result is delivered (when `onFinish` is set) before the waiter is released. */
  finish(id: string): void {
    const job = this.jobs.get(id)
    if (!job) return
    this.jobs.delete(id)
    this.onFinish?.(job)
    if (this.jobs.size) return
    for (const done of this.waiters.splice(0)) done()
  }

  /** Every job fails or is stopped: no result runs, and the worker must not wait again. */
  stopAll(): void {
    this.jobs.clear()
    for (const done of this.waiters.splice(0)) done()
  }
}

interface Setup {
  readonly handle: FakeConversation
  readonly jobs: FakeJobs
  readonly report: ReturnType<typeof vi.fn>
  readonly reply: ReturnType<typeof vi.fn>
  readonly log: ReturnType<typeof vi.fn>
  readonly run: () => Promise<void>
  readonly terminal: () => unknown
}

/** Build the worker task around fakes and return a driver for its single phase. */
const setup = (options: { timeoutMs?: number } = {}): Setup => {
  const handle = new FakeConversation()
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
  const kv = new Map<string, unknown>([[workerConversationKey(TICKET), CONVERSATION]])
  const store = {
    get: (key: string) => kv.get(key),
    set: (key: string, value: unknown) => { kv.set(key, value) },
    atomic: <T>(operation: () => T): T => operation(),
    tickets: { get: (id: string) => id === TICKET ? ticket : undefined, active: () => [], list: () => [ticket] },
    triggers: { get: () => undefined },
  } as unknown as Store
  const cfg = resolveSuperagentConfig({
    stateDir: '/tmp/worker-background-state',
    workDir: '/tmp/worker-background-work',
    harnessDir: '/tmp/worker-background-harness',
    maxWorkers: 1,
    evalMode: 'off',
    router: { provider: 'test', model: 'router' },
    worker: { provider: 'test', model: 'worker' },
    channel: { send: async () => 'sent' },
    watchdog: { mode: 'off' },
    workerTurnTimeoutMs: options.timeoutMs ?? 60_000,
    log,
  })

  let terminal: unknown
  const task = { id: 1, input: { ticketId: TICKET, assignmentId: ASSIGNMENT }, state: { phase: 'run', status: 'running' } }
  const runtime = {
    now: () => Date.now(),
    conversation: async () => handle,
    commit: async (change: (...args: unknown[]) => unknown) => {
      const next = await change({}, task)
      if (next !== undefined) terminal = next
    },
    context: async () => ({
      entries: handle.assistantText
        ? [{ id: 1, kind: 'pi.assistant', model: [{ content: [{ type: 'text', text: handle.assistantText }] }] } as unknown as EntryRecord]
        : [],
    }),
  } as unknown as WorkerRuntime

  const definition = createWorkerTask({
    store, cfg, jobs, bridges: { register: () => {}, release: () => {}, get: () => undefined } as never,
    engine: () => ({ report, reply } as unknown as Engine),
  })
  return {
    handle, jobs, report, reply, log,
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

describe('a worker turn with background jobs', () => {
  it('finishes after one round when the conversation runs no background job', async () => {
    const test = setup()
    const running = test.run()
    await until(() => test.handle.modelInputs.length === 1, 'the first model run')
    test.handle.endRun('第一轮完成')
    await running

    expect(test.jobs.waits).toHaveLength(0)
    expect(test.handle.submissions).toHaveLength(1)
    expect(test.handle.modelInputs).toHaveLength(1) // the model was asked once
    expect(test.report).toHaveBeenCalledTimes(1)
    expect(reportedSummary(test.report)).toBe('第一轮完成')
    expect(test.terminal()).toMatchObject({ status: 'terminal' })
  })

  it('waits for the job and the delivered result’s run, and the model reads the result in that run', async () => {
    const test = setup()
    test.jobs.add('bg-1', 'echo one')
    test.jobs.onFinish = job => test.handle.deliverResult(`[后台任务 ${job.id} 已结束] echo one`)
    const running = test.run()
    await until(() => test.handle.modelInputs.length === 1, 'the first model run')
    test.handle.endRun('第一轮先回复')

    // The worker must not finish while the job runs.
    await until(() => test.jobs.waits.length === 1, 'the worker to wait for the job')
    await sleep(20)
    expect(test.report).not.toHaveBeenCalled()

    test.jobs.finish('bg-1') // delivers the result, which starts the second model run
    await until(() => test.handle.modelInputs.length === 2, 'the second model run')
    expect(test.handle.modelInputs[1]).toContain('[后台任务 bg-1 已结束] echo one')
    await sleep(20)
    expect(test.report).not.toHaveBeenCalled() // still inside the result's run

    test.handle.endRun('第二轮读到结果')
    await running
    expect(test.jobs.waits).toHaveLength(1)
    expect(test.handle.submissions).toHaveLength(1) // the result came from react's delivery, not a re-submit
    expect(test.report).toHaveBeenCalledTimes(1)
    expect(reportedSummary(test.report)).toBe('第二轮读到结果')
    expect(test.log).toHaveBeenCalledWith('worker waits for background jobs', expect.objectContaining({
      ticketId: TICKET, conversationId: String(CONVERSATION), jobs: [{ id: 'bg-1', command: 'echo one' }],
    }))
    expect(test.log).toHaveBeenCalledWith('worker resumed after background jobs', { ticketId: TICKET, turns: 1 })
  })

  it('keeps waiting when a resumed round starts another background job', async () => {
    const test = setup()
    test.jobs.add('bg-1', 'echo one')
    test.jobs.onFinish = job => test.handle.deliverResult(`[后台任务 ${job.id} 已结束]`)
    const running = test.run()
    await until(() => test.handle.modelInputs.length === 1, 'the first model run')
    test.handle.endRun('第一轮')

    await until(() => test.jobs.waits.length === 1, 'the first wait')
    test.jobs.finish('bg-1')
    await until(() => test.handle.modelInputs.length === 2, 'the second model run')
    test.jobs.add('bg-2', 'echo two') // the model started another job during its result run
    test.handle.endRun('第二轮')

    await until(() => test.jobs.waits.length === 2, 'the second wait')
    await sleep(20)
    expect(test.report).not.toHaveBeenCalled()

    test.jobs.finish('bg-2')
    await until(() => test.handle.modelInputs.length === 3, 'the third model run')
    expect(test.handle.modelInputs[2]).toContain('[后台任务 bg-2 已结束]')
    test.handle.endRun('第三轮完成')
    await running

    expect(test.report).toHaveBeenCalledTimes(1)
    expect(reportedSummary(test.report)).toBe('第三轮完成')
    expect(test.log).toHaveBeenCalledWith('worker resumed after background jobs', { ticketId: TICKET, turns: 2 })
  })

  it('ends honestly with a note when a job outlives the turn deadline', async () => {
    const test = setup({ timeoutMs: 150 })
    test.jobs.add('bg-slow', 'sleep 600')
    const began = Date.now()
    const running = test.run()
    await until(() => test.handle.modelInputs.length === 1, 'the first model run')
    test.handle.endRun('第一轮先回复')
    await running

    expect(Date.now() - began).toBeLessThan(2000) // bounded, not hanging
    expect(test.jobs.waits).toHaveLength(1)
    const summary = reportedSummary(test.report)
    expect(summary).toContain('第一轮先回复')
    expect(summary).toContain('bg-slow')
    expect(summary).toContain('sleep 600')
    expect(summary).toContain('后台任务仍在运行')
    expect(test.reply).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'result', ticketId: TICKET, text: summary }))
  })

  it('finishes normally when every job failed or was stopped before the result rounds', async () => {
    const test = setup()
    test.jobs.add('bg-1', 'false')
    test.jobs.add('bg-2', 'sleep 30')
    const running = test.run()
    await until(() => test.handle.modelInputs.length === 1, 'the first model run')
    test.handle.endRun('第一轮先回复')
    await until(() => test.jobs.waits.length === 1, 'the wait')

    test.jobs.stopAll() // stopped/failed: no results to read, nothing left to wait for
    await running

    expect(test.jobs.waits).toHaveLength(1) // did not wait a second time
    expect(test.handle.modelInputs).toHaveLength(1) // no result run was started
    expect(test.report).toHaveBeenCalledTimes(1)
    expect(reportedSummary(test.report)).toBe('第一轮先回复')
  })
})
