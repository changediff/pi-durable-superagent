/**
 * Inline & Spill + chained recall (design doc §3.3): the recall tool's bounded views, the reference
 * chain (trigger → thread → ticket → conversation, plus outbox), spill cursors, the worker brief's
 * inline budget, and read-only guarantees. Everything runs against a real Store in a temp directory
 * with a faked conversation reader — no models, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationId, EntryId, EntryRecord } from '@earendil-works/pi-durable'
import { Store } from '../src/app/store.ts'
import type { Decision, Thread, Ticket, Trigger } from '../src/core/index.ts'
import { resolveSuperagentConfig, type ResolvedSuperagentConfig } from '../src/plugin/config.ts'
import { createRecallTool, recallObject, type RecallDeps } from '../src/plugin/recall.ts'
import { BRIEF_INLINE_LIMIT, workerBrief, workerConversationKey } from '../src/plugin/worker.ts'

const THREAD_KEY = 'feishu:oc_9:chat'
const CONVERSATION = '4242'

let directory: string
let store: Store

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sup-recall-'))
  store = new Store(join(directory, 'db.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
})

const trigger = (id: string, text: string): Trigger => ({
  id, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_9:chat' }],
  actor: { source: 'feishu', id: 'ou_a' }, human: true, addressed: 'direct',
  at: '2026-11-19T00:00:00.000Z', text, meta: {},
})

const ticket = (id: string, triggerId: string, over: Partial<Ticket> = {}): Ticket => ({
  id, title: `工单 ${id}`, decisionId: `d-${id}`,
  mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou_a' }, scope: '修复登录' },
  channels: [{ source: 'feishu', thread: 'oc_9:chat', address: {} }],
  assignments: [{ id: `a-${id}`, state: 'ended', createdAt: '2026-11-19T00:00:01.000Z', report: { state: 'ready', summary: '已完成：修复了登录', at: '2026-11-19T00:10:00.000Z' } }],
  inputs: [], undelivered: [],
  origin: { triggerId, triggerIds: [triggerId] },
  createdAt: '2026-11-19T00:00:01.000Z', updatedAt: '2026-11-19T00:10:00.000Z',
  ...over,
})

const thread = (over: Partial<Thread> = {}): Thread => ({
  key: THREAD_KEY, ref: { source: 'feishu', id: 'oc_9:chat' }, createdAt: '2026-11-19T00:00:00.000Z',
  lastAt: '2026-11-19T00:00:00.000Z', subscriptions: ['t-1'], correlated: [], pending: [], meta: {},
  ...over,
})

const acceptDecision = (id: string, ticketId: string): Decision => ({
  id, evalId: `e-${id}`, threadKey: THREAD_KEY, triggerIds: ['fs-om_1'], policyVersion: 'v',
  at: '2026-11-19T00:00:00.000Z', kind: 'accept', reason: [], strength: 'explicit', ticketId,
})

/** Fake transcript entries: a user message and an assistant reply, as the newest entries of the worker conversation. */
const entries = (): EntryRecord[] => [
  { id: 1 as EntryId, kind: 'pi.user', model: [{ content: '请修复登录页' }] },
  { id: 2 as EntryId, kind: 'pi.assistant', model: [{ content: [{ type: 'text', text: '已完成：修复了登录页并验证通过。' }] }] },
] as unknown as EntryRecord[]

const deps = (cfg: ResolvedSuperagentConfig, read = entries()): RecallDeps => ({
  store,
  cfg,
  readConversation: async id => (id === CONVERSATION ? { recent: read, total: read.length, capped: false } : undefined),
})

const config = (log: (message: string, detail?: unknown) => void = () => {}): ResolvedSuperagentConfig =>
  resolveSuperagentConfig({
    stateDir: directory, workDir: directory, harnessDir: directory, maxWorkers: 1, evalMode: 'off',
    router: { provider: 'test', model: 'router' }, worker: { provider: 'test', model: 'worker' },
    channel: { send: async () => 'sent' }, log,
  })

/** Seed the full reference graph: trigger → thread → two tickets (one ended, unsubscribed) → conversation → outbox. */
function seedGraph(longText?: string): void {
  store.triggers.save(trigger('fs-om_1', '请修复登录页'))
  if (longText) store.triggers.save(trigger('tr-long', longText))
  store.triggers.saveDisposition('fs-om_1', { fanout: ['t-1'], at: '2026-11-19T00:00:00.000Z' })
  store.threads.save(thread())
  store.tickets.save(ticket('t-1', 'fs-om_1'))
  // t-2 ended and no longer subscribed; its accept decision on the thread is what still links it.
  store.tickets.save(ticket('t-2', 'fs-om_1', {
    ended: { at: '2026-11-19T01:00:00.000Z', by: 'human', outcome: 'stopped' }, assignments: [],
  }))
  store.decisions.save(acceptDecision('d-t-1', 't-1'))
  store.decisions.save(acceptDecision('d-t-2', 't-2'))
  store.set(workerConversationKey('t-1'), Number(CONVERSATION) as ConversationId)
  store.receipts.add({ id: 'ob-1', channel: { source: 'feishu', thread: 'oc_9:chat', address: {} }, text: '已修复登录', kind: 'reply', ticketId: 't-1' })
}

const nextIds = (result: { next: { kind: string; id: string }[] }, kind: string): string[] =>
  result.next.filter(item => item.kind === kind).map(item => item.id)

/** Unwrap a successful recall outcome (a failing one fails the test with its message). */
const unwrap = (outcome: Awaited<ReturnType<typeof recallObject>>): { view?: Record<string, unknown>; page?: Record<string, unknown> } => {
  if (outcome.isError) throw new Error(outcome.message)
  return 'view' in outcome.result ? { view: outcome.result.view as unknown as Record<string, unknown> } : { page: outcome.result.page as unknown as Record<string, unknown> }
}

/** The view of a successful object recall, typed loosely for assertions. */
const viewOf = (outcome: Awaited<ReturnType<typeof recallObject>>): Record<string, unknown> & { next: { kind: string; id: string }[] } =>
  unwrap(outcome).view as Record<string, unknown> & { next: { kind: string; id: string }[] }

describe('recall: chained hops', () => {
  it('trigger → thread → ticket → conversation, each hop naming the next id', async () => {
    seedGraph()
    const outcome = await recallObject(deps(config()), { kind: 'trigger', id: 'fs-om_1' }, BACKGROUND_CONTEXT)
    const first = viewOf(outcome)
    expect(nextIds(first, 'thread')).toContain(THREAD_KEY)
    expect(nextIds(first, 'ticket')).toContain('t-1')

    const threadOutcome = await recallObject(deps(config()), { kind: 'thread', id: THREAD_KEY }, BACKGROUND_CONTEXT)
    const threadView = viewOf(threadOutcome)
    expect(nextIds(threadView, 'ticket')).toEqual(expect.arrayContaining(['t-1', 't-2']))
    expect(nextIds(threadView, 'trigger')).toContain('fs-om_1')

    const ticketOutcome = await recallObject(deps(config()), { kind: 'ticket', id: 't-1' }, BACKGROUND_CONTEXT)
    const ticketView = viewOf(ticketOutcome)
    expect(nextIds(ticketView, 'conversation')).toContain(CONVERSATION)
    expect(nextIds(ticketView, 'trigger')).toContain('fs-om_1')
    expect(nextIds(ticketView, 'outbox')).toContain('ob-1')

    const conversationOutcome = await recallObject(deps(config()), { kind: 'conversation', id: CONVERSATION }, BACKGROUND_CONTEXT)
    const conversationView = viewOf(conversationOutcome)
    expect(nextIds(conversationView, 'ticket')).toContain('t-1')
    expect(conversationView.total).toBe(2)
    expect(conversationView.recent).toHaveLength(2)
    expect(String(conversationView.summary)).toContain('已完成：修复了登录页')
  })

  it('a thread is also found by its raw thread id, not only by its key', async () => {
    seedGraph()
    const outcome = await recallObject(deps(config()), { kind: 'thread', id: 'oc_9:chat' }, BACKGROUND_CONTEXT)
    expect(viewOf(outcome).id).toBe(THREAD_KEY)
  })

  it('outbox replies chain back to their ticket and thread', async () => {
    seedGraph()
    const view = viewOf(await recallObject(deps(config()), { kind: 'outbox', id: 'ob-1' }, BACKGROUND_CONTEXT))
    expect(nextIds(view, 'ticket')).toContain('t-1')
    expect(nextIds(view, 'thread')).toContain(THREAD_KEY)
  })

  it('logs every recall with kind, id, bytes and spilled', async () => {
    seedGraph()
    const log = vi.fn()
    await recallObject(deps(config(log)), { kind: 'ticket', id: 't-1' }, BACKGROUND_CONTEXT)
    expect(log).toHaveBeenCalledWith('recall', expect.objectContaining({ kind: 'ticket', id: 't-1' }))
    expect(log.mock.calls.find(call => call[0] === 'recall')?.[1]).toMatchObject({ bytes: expect.any(Number), spilled: expect.any(Number) })
  })
})

describe('recall: spill and cursors', () => {
  const longText = 'A'.repeat(700) + 'B'.repeat(1600) + 'C'.repeat(700)

  it('spills a field over 800 chars to head 600 + tail 200 with a starting cursor', async () => {
    seedGraph(longText)
    const view = viewOf(await recallObject(deps(config()), { kind: 'trigger', id: 'tr-long' }, BACKGROUND_CONTEXT))
    expect(String(view.text).startsWith('A'.repeat(600))).toBe(true)
    expect(String(view.text)).toContain('spilled 2200 chars, recall with cursor')
    expect(String(view.text).endsWith('C'.repeat(200))).toBe(true)
    expect(view.textCursor).toBe('text:0')
  })

  it('pages the spilled field back together with cursors, ending with an empty nextCursor', async () => {
    seedGraph(longText)
    const recall = deps(config())
    const page1 = unwrap(await recallObject(recall, { kind: 'trigger', id: 'tr-long', cursor: 'text:0' }, BACKGROUND_CONTEXT)).page as { segment: string; nextCursor: string }
    expect(page1.segment).toBe(longText.slice(0, 2000))
    expect(page1.nextCursor).toBe('text:2000')
    const page2 = unwrap(await recallObject(recall, { kind: 'trigger', id: 'tr-long', cursor: page1.nextCursor }, BACKGROUND_CONTEXT)).page as { segment: string; nextCursor: string }
    expect(page2.segment).toBe(longText.slice(2000))
    expect(page2.nextCursor).toBe('')
    expect(page1.segment + page2.segment).toBe(longText)
  })

  it('keeps short fields inline without a cursor', async () => {
    seedGraph()
    const view = viewOf(await recallObject(deps(config()), { kind: 'trigger', id: 'fs-om_1' }, BACKGROUND_CONTEXT))
    expect(view.text).toBe('请修复登录页')
    expect(view.textCursor).toBeUndefined()
  })

  it('rejects a malformed cursor with the pageable fields listed', async () => {
    seedGraph(longText)
    const outcome = await recallObject(deps(config()), { kind: 'trigger', id: 'tr-long', cursor: 'nope' }, BACKGROUND_CONTEXT)
    expect(outcome.isError).toBe(true)
    expect(outcome.isError && outcome.message).toContain('bad cursor')
  })
})

describe('recall: unknown ids', () => {
  it('answers isError and lists the most recent ids of the kind', async () => {
    seedGraph()
    const ticketOutcome = await recallObject(deps(config()), { kind: 'ticket', id: 't-nope' }, BACKGROUND_CONTEXT)
    expect(ticketOutcome.isError).toBe(true)
    expect(ticketOutcome.isError && ticketOutcome.message).toContain('t-1')
    expect(ticketOutcome.isError && ticketOutcome.recentIds).toContain('t-1')

    const triggerOutcome = await recallObject(deps(config()), { kind: 'trigger', id: 'nope' }, BACKGROUND_CONTEXT)
    expect(triggerOutcome.isError).toBe(true)
    expect(triggerOutcome.isError && triggerOutcome.recentIds).toContain('fs-om_1')

    const conversationOutcome = await recallObject(deps(config()), { kind: 'conversation', id: '999' }, BACKGROUND_CONTEXT)
    expect(conversationOutcome.isError).toBe(true)
    expect(conversationOutcome.isError && conversationOutcome.recentIds).toContain(CONVERSATION)
  })
})

describe('worker brief: inline with ids, spill beyond the budget', () => {
  it('spills an over-budget origin message, keeping head 800 + tail 300 and the recall reference', async () => {
    const longText = 'A'.repeat(700) + 'B'.repeat(1600) + 'C'.repeat(700)
    seedGraph(longText)
    const log = vi.fn()
    const brief = workerBrief(store, config(log), ticket('t-1', 'tr-long'))
    expect(brief).toContain(`[trigger:tr-long thread:${THREAD_KEY}]`)
    expect(brief).toContain('recall({kind:\'trigger\', id:\'tr-long\'})')
    expect(brief).toContain('A'.repeat(700))            // head 800 keeps all 700 A's
    expect(brief).toContain('C'.repeat(300))            // tail keeps the last 300 C's
    expect(brief).not.toContain('B'.repeat(400))        // the middle is spilled out
    expect(brief).toContain('spilled 1900 chars')
    expect(log).toHaveBeenCalledWith('brief spill', { ticketId: 't-1', triggerId: 'tr-long', chars: 3000, kept: 1100 })
  })

  it(`keeps an origin message under ${BRIEF_INLINE_LIMIT} chars verbatim, still carrying the ids`, () => {
    seedGraph()
    const brief = workerBrief(store, config(), ticket('t-1', 'fs-om_1'))
    expect(brief).toContain('请修复登录页')
    expect(brief).toContain(`[trigger:fs-om_1 thread:${THREAD_KEY}]`)
    expect(brief).not.toContain('spilled')
  })

  it('inlines nothing when the origin trigger is missing', () => {
    store.tickets.save(ticket('t-1', 'fs-gone'))
    const brief = workerBrief(store, config(), store.tickets.get('t-1')!)
    expect(brief).toContain('# 工单：工单 t-1')
    expect(brief).not.toContain('发起人消息')
  })
})

describe('recall: read-only', () => {
  /** Serialise every table of the store so any write during recall shows up as a diff. */
  const dump = (): string => {
    const tables = ['kv', 'trigger', 'disposition', 'thread', 'ticket', 'decision', 'outbox', 'trigger_thread', 'effect']
    return tables.map(table => `${table}:${JSON.stringify(store.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all())}`).join('\n')
  }

  it('leaves the store untouched across every kind, unknown ids, and cursor pages', async () => {
    const longText = 'A'.repeat(700) + 'B'.repeat(1600) + 'C'.repeat(700)
    seedGraph(longText)
    const recall = deps(config())
    const before = dump()
    const spies = [
      vi.spyOn(store, 'set'), vi.spyOn(store, 'delete'),
      vi.spyOn(store.triggers, 'save'), vi.spyOn(store.triggers, 'saveDisposition'),
      vi.spyOn(store.threads, 'save'), vi.spyOn(store.tickets, 'save'), vi.spyOn(store.decisions, 'save'),
      vi.spyOn(store.receipts, 'add'), vi.spyOn(store.receipts, 'settle'), vi.spyOn(store.receipts, 'withdraw'),
    ]
    const calls = [
      { kind: 'trigger', id: 'fs-om_1' }, { kind: 'trigger', id: 'tr-long', cursor: 'text:0' },
      { kind: 'thread', id: THREAD_KEY }, { kind: 'ticket', id: 't-1' },
      { kind: 'conversation', id: CONVERSATION }, { kind: 'outbox', id: 'ob-1' },
      { kind: 'ticket', id: 'unknown' }, { kind: 'trigger', id: 'unknown', cursor: 'text:0' },
    ] as const
    for (const args of calls) await recallObject(recall, { ...args }, BACKGROUND_CONTEXT)
    expect(dump()).toBe(before)
    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })

  it('exposes the tool under the name "recall" with a JSON view as its output', async () => {
    seedGraph()
    const tool = createRecallTool(deps(config()))
    expect(tool.name).toBe('recall')
    const result = await tool.execute(
      { kind: 'ticket', id: 't-1' },
      {} as never,
      BACKGROUND_CONTEXT,
    )
    const text = result.output?.[0]
    const rendered = text && text.type === 'text' ? text.text : ''
    expect(rendered).toContain('"id": "t-1"')
    expect(rendered).toContain('"next"')
  })
})
