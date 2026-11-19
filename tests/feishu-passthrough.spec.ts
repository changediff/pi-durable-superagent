/** Feishu link integration: a real FeishuSource turns WS events into Triggers and Intake routes them, proving a follow-up on the
 * same Thread reaches its ticket without the Router while a Thread a person stopped goes back to Eval. */
import { describe, expect, it, vi } from 'vitest'
import { FeishuSource, feishuThreadId, type MessageEvent } from '../src/pi/feishu.ts'
import { loadConfig } from '../src/pi/config.ts'
import { Engine, MemoryRepositories, followupOwners, runningAssignment } from '../src/core/index.ts'
import type { Assessor, Assignment, Candidate, Executor, Outcome, OutboundMessage, Policy, Ticket, Trigger } from '../src/core/index.ts'

const THREAD = 'feishu:oc_1:chat'

/** One Feishu text message; `at` advances so each message is later than the last, as real `create_time` values are. */
let clock = 1_767_225_600 // 2026-01-01T00:00:00Z, in Feishu's whole seconds
function event({ messageId, chatId = 'oc_1', chatType = 'p2p', rootId, threadId, text = 'hi', openId = 'ou_alice',
  mentioned = false }: { messageId: string; chatId?: string; chatType?: 'p2p' | 'group'; rootId?: string; threadId?: string
  text?: string; openId?: string; mentioned?: boolean }): MessageEvent {
  return {
    sender: { sender_type: 'user', sender_id: { open_id: openId } },
    message: {
      message_id: messageId, chat_id: chatId, chat_type: chatType, message_type: 'text', content: JSON.stringify({ text }),
      ...(mentioned ? { mentions: [{ key: '@_user_1', name: 'bot' }] } : {}),
      ...(rootId ? { root_id: rootId } : {}), ...(threadId ? { thread_id: threadId } : {}),
      create_time: String(clock++),
    },
  }
}

/** A FeishuSource that never connects (`start()` is what opens the socket), driven straight at its private receive. */
const into = (source: FeishuSource) => (data: MessageEvent) =>
  (source as unknown as { receive(data: MessageEvent): void }).receive(data)
/** Defaults plus fake credentials: the SDK's Client refuses an empty appSecret, and the source never connects in tests. */
const testConfig = () => loadConfig({ FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'test_secret' })
/** A source that only captures the Triggers it converts, for Thread-identity checks without an engine. */
function converter(onTrigger: (trigger: Trigger) => void) {
  const source = new FeishuSource(testConfig(), { onTrigger, log: () => undefined })
  return { deliver: into(source), source }
}

/** The engine harness of core-engine.spec.ts, with a real FeishuSource as both the source and the scope. */
function harness() {
  const repo = new MemoryRepositories()
  const requests: Candidate[] = []
  const assessor: Assessor = { request: vi.fn((candidate: Candidate) => { requests.push(candidate) }), release: vi.fn() }
  const launches: [Ticket, Assignment][] = []
  const deliveries = new Set<string>()
  const executor: Executor = {
    start: vi.fn((ticket, assignment) => { launches.push([ticket, assignment]) }),
    deliver: vi.fn(ticket => { deliveries.add(ticket.id) }),
    stop: vi.fn(),
  }
  const policy: Policy = {
    version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: (t, thread) => !t.human ? { admissible: false, reason: 'not human' }
      : t.actor.id === 'ou_alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
      : thread.subscriptions.length ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } }
      : { admissible: false, reason: 'not a member' },
    revalidate: () => true, admitsInferred: rules => rules.length > 0,
  }
  const outbox: OutboundMessage[] = []
  const logs: unknown[][] = []
  // The runtime wires the source's host straight into the domain: onTrigger → plugin.ingest → engine.receive.
  const source = new FeishuSource(testConfig(), { onTrigger: trigger => engine.receive(trigger), log: (m, d) => logs.push([m, d]) })
  const engine = new Engine({ repo, scope: source, policy: () => policy, assessor, executor,
    outbox: { send: m => { if (!outbox.some(item => item.id === m.id)) outbox.push(m) },
      status: id => outbox.some(item => item.id === id) ? 'pending' : undefined, withdraw: () => undefined },
    log: (m, d) => logs.push([m, d]), now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, 30)).toISOString() })
  const deliver = into(source)
  function settle() {
    for (;;) {
      const next = launches.shift()
      if (next) { engine.assignmentStarted(next[0].id, next[1].id); continue }
      const [ticketId] = deliveries
      if (ticketId === undefined) return
      deliveries.delete(ticketId)
      const ticket = repo.tickets.get(ticketId)!
      const assignment = runningAssignment(ticket)
      if (ticket.ended || !assignment) continue
      for (const inputId of ticket.undelivered) engine.inputsDelivered(ticketId, assignment.id, [inputId])
    }
  }
  const pump = () => { engine.evaluateDue(); settle() }
  const decide = (candidate: Candidate, outcome: Outcome) => engine.decide(candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId })
  return { repo, engine, assessor, executor, requests, logs, deliver, settle, pump, decide }
}
/** A first Feishu message on a fresh Thread, accepted into a ticket that subscribes to it. */
function subscribed() {
  const h = harness()
  h.deliver(event({ messageId: 'om_1', text: '帮我修 README 的徽章' })); h.pump()
  const decision = h.decide(h.requests[0]!, { kind: 'accept', title: 'Fix badge', scope: 'small', reason: 'requested', acknowledgement: '收到' })
  h.settle()
  return { h, ticketId: decision.ticketId! }
}

describe('feishu thread identity', () => {
  it('keys two rootless messages of one chat onto the same conversation-level Thread', () => {
    const converted: Trigger[] = []
    const { deliver } = converter(trigger => converted.push(trigger))
    deliver(event({ messageId: 'om_1' }))
    deliver(event({ messageId: 'om_2' }))
    const [first, second] = converted
    // No root_id or thread_id: p2p and plain group messages share the chat-level Thread `<chat>:chat`.
    expect(first!.threads).toEqual([{ source: 'feishu', id: 'oc_1:chat' }])
    expect(second!.threads[0]!.id).toBe(first!.threads[0]!.id)
    expect(first!.threads[0]!.id).toBe(feishuThreadId('oc_1', undefined, 'om_2'))
    expect(first!.threads[0]!.id).toBe('oc_1:chat')
  })
  it('keeps each topic root its own Thread inside one chat', () => {
    const converted: Trigger[] = []
    const { deliver } = converter(trigger => converted.push(trigger))
    const inTopic = (rootId: string, messageId: string) => event({ messageId, chatType: 'group', mentioned: true, rootId })
    deliver(inTopic('om_root', 'om_3')); deliver(inTopic('om_root', 'om_4'))
    deliver(inTopic('om_other', 'om_5'))
    deliver(event({ messageId: 'om_6', chatType: 'group', mentioned: true }))
    const ids = converted.map(trigger => trigger.threads[0]!.id)
    // Same root, same Thread; a different root is a different Thread, and a rootless message is not the topic's.
    expect(ids[0]).toBe(ids[1]); expect(ids[0]).toBe('oc_1:om_root')
    expect(ids[2]).not.toBe(ids[0]); expect(ids[2]).toBe('oc_1:om_other')
    expect(ids[3]).not.toBe(ids[0]); expect(ids[3]).toBe('oc_1:chat')
  })
})

describe('the feishu link through Intake', () => {
  it('queues the first message of a Thread for Eval, and its accept subscribes the ticket to that Thread', () => {
    const h = harness()
    h.deliver(event({ messageId: 'om_1', text: '帮我修 README 的徽章' }))
    // Cold start: nothing subscribes to the Thread, so Intake queues the Trigger for Eval.
    expect(h.repo.threads.get(THREAD)!.pending).toEqual(['fs-om_1'])
    expect(h.logs).toContainEqual(['eval queued', { triggerId: 'fs-om_1', threads: ['feishu:oc_1:chat'] }])
    h.pump()
    expect(h.assessor.request).toHaveBeenCalledOnce()
    const decision = h.decide(h.requests[0]!, { kind: 'accept', title: 'Fix badge', scope: 'small', reason: 'requested', acknowledgement: '收到' })
    h.settle()
    expect(h.repo.threads.get(THREAD)!.subscriptions).toEqual([decision.ticketId])
    expect(h.executor.start).toHaveBeenCalledOnce()
  })
  it('routes the second message of the same Thread straight to the subscribed ticket, without Eval', () => {
    const { h, ticketId } = subscribed()
    const evals = h.requests.length
    h.deliver(event({ messageId: 'om_2', text: '顺手把链接也改了' })); h.settle()
    // The same `<chat>:chat` Thread: the ticket owns the follow-up, so Intake neither queues it nor asks the Router.
    expect(h.repo.triggers.disposition('fs-om_2')!.fanout).toEqual([ticketId])
    expect(followupOwners(h.repo.triggers.get('fs-om_2')!, h.repo)).toEqual([ticketId])
    expect(h.repo.threads.get(THREAD)!.pending).toEqual([])
    h.pump()
    expect(h.requests.length).toBe(evals)
    expect(h.logs).toContainEqual(['passthrough', { triggerId: 'fs-om_2', tickets: [ticketId], threads: ['feishu:oc_1:chat'] }])
    expect(h.logs.some(([message, detail]) => message === 'eval queued' && (detail as { triggerId: string }).triggerId === 'fs-om_2')).toBe(false)
    // The ticket's worker received it as an Input, delivered to the running assignment.
    const ticket = h.repo.tickets.get(ticketId)!
    expect(ticket.inputs.at(-1)).toMatchObject({ kind: 'trigger', triggerId: 'fs-om_2' })
    expect(ticket.undelivered).toEqual([])
  })
  it('returns the Thread to Eval once a person stopped the ticket that subscribed to it', () => {
    const { h, ticketId } = subscribed()
    h.engine.stopTicket(ticketId)
    expect(h.repo.tickets.get(ticketId)!.ended).toMatchObject({ by: 'human' })
    const evals = h.requests.length
    h.deliver(event({ messageId: 'om_3', text: '还在吗' })); h.pump()
    // A human-stopped ticket withdrew its mandate: the same Thread's new message reaches no ticket and goes back to Eval.
    expect(h.repo.triggers.disposition('fs-om_3')!.fanout).toEqual([])
    expect(followupOwners(h.repo.triggers.get('fs-om_3')!, h.repo)).toEqual([])
    expect(h.repo.threads.get(THREAD)!.pending).toEqual([])
    expect(h.requests.length).toBe(evals + 1)
    expect(h.requests.at(-1)!.triggers.map(trigger => trigger.id)).toEqual(['fs-om_3'])
    expect(h.logs).toContainEqual(['eval queued', { triggerId: 'fs-om_3', threads: ['feishu:oc_1:chat'] }])
    expect(h.logs.some(([message]) => message === 'passthrough')).toBe(false)
    expect(h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'trigger' && input.triggerId === 'fs-om_3')).toEqual([])
  })
})
