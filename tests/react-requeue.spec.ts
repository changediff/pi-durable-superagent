/**
 * Requeueing a finished background result: a live ticket just reads the message its turn receives,
 * but an ended ticket must re-enter the domain as a non-human environment event (`react:<jobId>`) so
 * an Eval can decide whether to resume it. Zero network: the hook is exercised against fakes, and
 * delivery against a fake session and real /bin/sh.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Thread, Ticket, Trigger } from '../src/core/index.ts'
import { settingsPolicy } from '../src/policy.ts'
import { createSuperagentExtension, type SuperagentConfig } from '../src/plugin/index.ts'
import { BackgroundJobs, createReactExtension, requeueReactResult, type ReactResultInput, type ReactSession } from '../src/plugin/react.ts'

const at = '2026-09-23T00:00:00.000Z'

const thread = (overrides: Partial<Thread> = {}): Thread => ({
  key: 'feishu:chat-1',
  ref: { source: 'feishu', id: 'chat-1' },
  createdAt: at,
  subscriptions: ['ticket-1'],
  correlated: [],
  pending: [],
  meta: {},
  ...overrides,
})

const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 'ticket-1',
  title: 'Fix the build',
  decisionId: 'decision-1',
  mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'user-1' }, scope: 'fix' },
  channels: [],
  assignments: [],
  inputs: [],
  undelivered: [],
  createdAt: at,
  updatedAt: at,
  origin: { triggerId: 'fs-1', triggerIds: ['fs-1'] },
  ...overrides,
})

interface Fakes {
  readonly receive: ReturnType<typeof vi.fn>
  readonly log: ReturnType<typeof vi.fn>
  readonly triggers: Map<string, Trigger>
  run(ticket: Ticket | undefined, input: ReactResultInput): void
}

/** The hook against in-memory tickets, threads and triggers, with Engine.receive's dedupe simulated. */
const fakes = (options: { threads?: Thread[]; ticket?: Ticket; stored?: Trigger[] } = {}): Fakes => {
  const triggers = new Map((options.stored ?? []).map(item => [item.id, item]))
  const receive = vi.fn((trigger: Trigger) => {
    if (triggers.has(trigger.id)) return 'duplicate'
    triggers.set(trigger.id, trigger)
    return 'stored'
  })
  const log = vi.fn()
  return {
    receive,
    log,
    triggers,
    run: (current, input) => requeueReactResult({
      ticket: () => current,
      threads: () => options.threads ?? [thread()],
      trigger: id => triggers.get(id),
      receive,
      log,
      now: () => at,
    }, input),
  }
}

const result = (overrides: Partial<ReactResultInput> = {}): ReactResultInput => ({
  jobId: 'bg-1',
  conversationId: '7',
  ticketId: 'ticket-1',
  content: '[后台任务 bg-1 已结束] status=exited exit=0 耗时=1.0s',
  ...overrides,
})

describe('the react result requeue hook', () => {
  it('leaves a live ticket alone: its turn reads the delivered message', () => {
    const fake = fakes()
    fake.run(ticket(), result())
    expect(fake.receive).not.toHaveBeenCalled()
    expect(fake.log).not.toHaveBeenCalled()
  })

  it('sends an ended ticket a non-human react trigger on its subscribed thread', () => {
    const fake = fakes()
    const ended = ticket({ ended: { at, by: 'executor', outcome: 'completed' } })
    fake.run(ended, result())
    expect(fake.receive).toHaveBeenCalledTimes(1)
    const trigger = fake.receive.mock.calls[0]![0] as Trigger
    expect(trigger).toMatchObject({
      id: 'react:bg-1',
      source: 'react',
      human: false,
      at,
      threads: [{ source: 'feishu', id: 'chat-1' }],
      text: result().content,
      meta: { jobId: 'bg-1', conversationId: '7', ticketId: 'ticket-1', background: true },
    })
    expect(fake.log).toHaveBeenCalledWith('react result requeued', { jobId: 'bg-1', triggerId: 'react:bg-1', thread: 'feishu:chat-1' })
  })

  it('is idempotent: the same job is received only once', () => {
    const fake = fakes()
    const ended = ticket({ ended: { at, by: 'executor', outcome: 'completed' } })
    fake.run(ended, result())
    fake.run(ended, result())
    expect(fake.receive).toHaveBeenCalledTimes(1)
    expect(fake.triggers.size).toBe(1)
  })

  it('does not throw and only logs when the ticket subscribes to no thread', () => {
    const fake = fakes({ threads: [thread({ subscriptions: [] })] })
    const ended = ticket({ ended: { at, by: 'executor', outcome: 'completed' } })
    expect(() => fake.run(ended, result())).not.toThrow()
    expect(fake.receive).not.toHaveBeenCalled()
    expect(fake.log).toHaveBeenCalledWith('react result ignored', expect.objectContaining({ jobId: 'bg-1', ticketId: 'ticket-1' }))
  })

  it('does not throw for an unknown ticket, a missing ticket id, or an unknown conversation', () => {
    const fake = fakes()
    expect(() => fake.run(undefined, result())).not.toThrow()
    expect(() => fake.run(ticket(), result({ ticketId: undefined }))).not.toThrow()
    expect(() => fake.run(ticket(), result({ ticketId: undefined, conversationId: 'missing' }))).not.toThrow()
    expect(fake.receive).not.toHaveBeenCalled()
  })

  it('does not throw when the Engine refuses the trigger', () => {
    const fake = fakes()
    fake.receive.mockImplementation(() => { throw new Error('intake closed') })
    const ended = ticket({ ended: { at, by: 'executor', outcome: 'completed' } })
    expect(() => fake.run(ended, result())).not.toThrow()
    expect(fake.log).toHaveBeenCalledWith('react result requeue failed', expect.stringContaining('bg-1'))
  })
})

/** The fake conversation: records every result message submitted into the session. */
class FakeSession implements ReactSession {
  readonly submissions: { type: string; content: string; requestId?: string; whenBusy?: string }[] = []
  async submit(submission: { type: 'input'; content: string; requestId?: string; whenBusy?: string }): Promise<{ id: string }> {
    this.submissions.push(submission)
    return { id: `sub-${this.submissions.length}` }
  }
}

interface ToolLike { execute(args: unknown, api: unknown, context: unknown): Promise<unknown> }

const waitFor = async (probe: () => boolean, what: string, limitMs = 5000): Promise<void> => {
  const deadline = Date.now() + limitMs
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

const started = (value: unknown): { id: string; pid: number } => {
  const structured = (value as { structuredOutput: { id: string; status: string; pid: number } }).structuredOutput
  expect(structured.status).toBe('started')
  return { id: structured.id, pid: structured.pid }
}

describe('the react Source is admissible', () => {
  it('seeds the settings policy so a senderless result reaches Eval instead of being filtered', () => {
    const root = mkdtempSync(join(tmpdir(), 'react-gate-'))
    try {
      const config: SuperagentConfig = {
        stateDir: join(root, 'state'),
        workDir: join(root, 'work'),
        harnessDir: join(root, 'harness'),
        maxWorkers: 1,
        evalMode: 'auto',
        router: { provider: 'faux', model: 'router-1' },
        worker: { provider: 'faux', model: 'worker-1' },
        channel: { send: async () => 'sent' },
        assessor: { baseUrl: 'http://127.0.0.1:9', apiKeyEnv: 'UNSET_FOR_TEST' },
        allowAll: true,
      }
      const plugin = createSuperagentExtension(config)
      const settings = plugin.store.settings()
      expect(settings.policy.sources['react']).toMatchObject({ admission: { system: { unlistedUnaddressed: 'inferred' } } })
      // The plugin's scope reports this Source as observed; the gate then admits the system event as inferred.
      const policy = settingsPolicy(settings, {
        scope: input => input.source === 'react' ? { listened: true, observed: true, row: 'system' } : { listened: false, reason: 'not react' },
      })
      const result: Trigger = {
        id: 'react:bg-1', source: 'react', threads: [{ source: 'feishu', id: 'chat-1' }], actor: { source: 'react', id: '' },
        human: false, at, text: 'done', meta: { jobId: 'bg-1' },
      }
      expect(policy.gate(result, thread(), [])).toMatchObject({ admissible: true, strength: 'inferred' })
      plugin.store.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('react delivery calls the result hook', () => {
  let directory: string
  let jobs: BackgroundJobs | undefined

  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'react-requeue-')) })
  afterEach(() => {
    jobs?.disposeAll()
    jobs = undefined
    rmSync(directory, { recursive: true, force: true })
  })

  const setup = (options: { ticketOf?: (id: string) => string | undefined; session?: ReactSession } = {}) => {
    const session = options.session ?? new FakeSession()
    const onResult = vi.fn()
    jobs = new BackgroundJobs()
    const extension = createReactExtension({
      session: async () => session,
      ticketOf: options.ticketOf,
      onResult,
      jobs,
      log: () => {},
    })
    const tool = extension.tools!.find(candidate => candidate.name === 'start') as unknown as ToolLike
    const start = (command: string) => tool.execute({ command, cwd: directory }, { conversationId: '7', callId: 'call-1' }, {})
    return { session: session as FakeSession, onResult, start }
  }

  it('calls onResult after a successful submit, with the conversation and its ticket', async () => {
    const { session, onResult, start } = setup({ ticketOf: id => id === '7' ? 'ticket-1' : undefined })
    const { id } = started(await start('echo ok'))
    await waitFor(() => onResult.mock.calls.length === 1, 'the result hook')
    expect(onResult).toHaveBeenCalledWith({ jobId: id, conversationId: '7', ticketId: 'ticket-1', content: session.submissions[0]!.content })
  })

  it('does not call onResult when the conversation is gone', async () => {
    const log = vi.fn()
    jobs = new BackgroundJobs()
    const onResult = vi.fn()
    const extension = createReactExtension({ session: async () => undefined, onResult, jobs, log })
    const start = extension.tools!.find(candidate => candidate.name === 'start') as unknown as ToolLike
    await start.execute({ command: 'echo ok', cwd: directory }, { conversationId: '7', callId: 'call-1' }, {})
    await waitFor(() => log.mock.calls.some(([message]) => message === 'react result dropped'), 'the dropped result')
    expect(onResult).not.toHaveBeenCalled()
  })

  it('keeps a successful delivery when the hook throws', async () => {
    const log = vi.fn()
    jobs = new BackgroundJobs()
    const extension = createReactExtension({
      session: async () => new FakeSession(),
      onResult: () => { throw new Error('hook exploded') },
      jobs,
      log,
    })
    const start = extension.tools!.find(candidate => candidate.name === 'start') as unknown as ToolLike
    started(await start.execute({ command: 'echo ok', cwd: directory }, { conversationId: '7', callId: 'call-1' }, {}))
    await waitFor(() => log.mock.calls.some(([message]) => message === 'react result hook failed'), 'the hook failure log')
    expect(log.mock.calls.some(([message]) => message === 'react result delivered')).toBe(true)
  })
})
