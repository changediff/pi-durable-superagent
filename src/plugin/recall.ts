/**
 * The recall tool (design doc §3.3): treat the context window as a cache.
 *
 * Inline keeps the information a turn will likely need inside the window (the worker brief inlines
 * the origin message's head and tail with its ids); Spill keeps everything else outside it, leaving
 * only a reference. `recall` is the read side of that bargain: given one object id it returns a
 * bounded, structured view — `id`, `kind`, a one-line `summary`, and `next`, the ids of the next hop
 * in the reference graph — so a model can chain recall (trigger → thread → ticket → conversation →
 * …) instead of asking for whole histories. Long single fields spill: the view shows head + tail
 * plus a marker, and `cursor` pages through the full text in bounded segments. The tool is strictly
 * read-only: it writes nothing and calls no model.
 */
import { defineTool } from '@earendil-works/pi-durable'
import type { EntryRecord } from '@earendil-works/pi-durable'
import { obj, oneOf, opt, str } from '@earendil-works/pi-schema'
import type { Context } from '@earendil-works/chord/context'
import { threadKey, type Thread, type Ticket, type Trigger } from '../core/index.ts'
import { KV, record } from '../kv.ts'
import type { Receipt, Store } from '../app/store.ts'
import type { ResolvedSuperagentConfig } from './config.ts'
import { activityLine } from './transcript.ts'
import { workerConversationKey } from './worker.ts'

export const RECALL_TOOL = 'recall'
export const RECALL_KINDS = ['trigger', 'thread', 'ticket', 'conversation', 'outbox'] as const
export type RecallKind = (typeof RECALL_KINDS)[number]

/** A single field longer than this spills: head + tail inline, the middle behind a cursor. */
export const SPILL_FIELD_LIMIT = 800
const SPILL_HEAD = 600
const SPILL_TAIL = 200
/** One cursor page of a spilled field carries at most this many characters. */
export const SPILL_SEGMENT = 2000
/** How many recent entries a conversation view summarises; the whole history never leaves the store. */
export const CONVERSATION_RECENT_LIMIT = 20
/** Cap on a conversation's counted total entries (`total` stops there and `capped` says so). */
const CONVERSATION_COUNT_CAP = 1000
/** How many next-hop refs one view carries per referenced kind; counts live in the view fields. */
const NEXT_PER_KIND = 5
/** How many recent ids the unknown-id error suggests. */
const UNKNOWN_HINT_IDS = 5

export interface RecallDeps {
  readonly store: Store
  readonly cfg: ResolvedSuperagentConfig
  /**
   * Read a conversation's newest transcript entries plus a capped total, read-only; `undefined`
   * when the conversation does not exist. Production wires this to the harness's entry scan.
   */
  readConversation(
    conversationId: string, recent: number, countCap: number, context: Context,
  ): Promise<{ recent: EntryRecord[]; total: number; capped: boolean } | undefined>
}

export interface RecallArgs { kind: RecallKind; id: string; cursor?: string }
/** One next hop in the reference graph. */
export interface RecallRef { kind: RecallKind; id: string; why: string }
/** A bounded object view: `summary` is one line, `next` chains recall, other fields are kind-specific. */
export interface RecallView { id: string; kind: RecallKind; summary: string; next: RecallRef[]; [field: string]: unknown }
/** One page of a spilled field, re-assembled by concatenating `segment`s in order. */
export interface RecallPage { kind: RecallKind; id: string; field: string; offset: number; segment: string; nextCursor: string }
export type RecallResult = { view: RecallView } | { page: RecallPage }
export type RecallOutcome = { isError: false; result: RecallResult } | { isError: true; message: string; recentIds: string[] }

/** What one loaded object yields for rendering: its view, the full texts its cursors page, and how much spilled. */
interface Loaded { view: RecallView; fields: Record<string, string>; spilled: number }

/** Spill one field per the budget: short fields pass through untouched, long ones keep head + tail and a starting cursor. */
export function spillText(text: string, field: string): { text: string; spilled: number; cursor?: string } {
  if (text.length <= SPILL_FIELD_LIMIT) return { text, spilled: 0 }
  const spilled = text.length - SPILL_HEAD - SPILL_TAIL
  return {
    text: `${text.slice(0, SPILL_HEAD)}… spilled ${spilled} chars, recall with cursor …${text.slice(-SPILL_TAIL)}`,
    spilled,
    cursor: `${field}:0`,
  }
}

/** Recall one object (or one page of one spilled field); never writes, never calls a model. */
export async function recallObject(deps: RecallDeps, args: RecallArgs, context: Context): Promise<RecallOutcome> {
  const loaded = await load(deps, args.kind, args.id, context)
  if (!loaded) {
    const recentIds = recentIdsOfKind(deps, args.kind)
    const message = `recall: no ${args.kind} with id "${args.id}".`
      + (recentIds.length ? ` Recent ${args.kind} ids: ${recentIds.join(', ')}.` : ' No stored ids of this kind yet.')
    deps.cfg.log('recall', { kind: args.kind, id: args.id, bytes: message.length, spilled: 0 })
    return { isError: true, message, recentIds }
  }
  if (args.cursor !== undefined) {
    const page = pageField(args, loaded)
    if (!page) {
      const message = `recall: bad cursor "${args.cursor}" for ${args.kind} "${args.id}"`
        + ` (expected "<field>:<offset>"; pageable fields: ${Object.keys(loaded.fields).join(', ') || 'none'}).`
      deps.cfg.log('recall', { kind: args.kind, id: args.id, bytes: message.length, spilled: 0 })
      return { isError: true, message, recentIds: [] }
    }
    deps.cfg.log('recall', { kind: args.kind, id: args.id, bytes: page.segment.length, spilled: 0 })
    return { isError: false, result: { page } }
  }
  deps.cfg.log('recall', { kind: args.kind, id: args.id, bytes: JSON.stringify(loaded.view).length, spilled: loaded.spilled })
  return { isError: false, result: { view: loaded.view } }
}

/** One page of a spilled field: `segment` of at most SPILL_SEGMENT chars, `nextCursor` empty at the end. */
function pageField(args: RecallArgs, loaded: Loaded): RecallPage | undefined {
  const match = /^([^:]+):(\d+)$/.exec(args.cursor ?? '')
  const field = match?.[1]
  const offset = match ? Number(match[2]) : NaN
  if (!field || !(field in loaded.fields) || !Number.isInteger(offset) || offset < 0) return undefined
  const full = loaded.fields[field]!
  const end = Math.min(offset + SPILL_SEGMENT, full.length)
  return {
    kind: args.kind, id: args.id, field, offset,
    segment: full.slice(offset, end),
    nextCursor: end < full.length ? `${field}:${end}` : '',
  }
}

async function load(deps: RecallDeps, kind: RecallKind, id: string, context: Context): Promise<Loaded | undefined> {
  switch (kind) {
    case 'trigger': { const trigger = deps.store.triggers.get(id); return trigger ? triggerView(deps, trigger) : undefined }
    case 'thread': return threadView(deps, id)
    case 'ticket': { const ticket = deps.store.tickets.get(id); return ticket ? ticketView(deps, ticket) : undefined }
    case 'conversation': return await conversationView(deps, id, context)
    case 'outbox': { const receipt = deps.store.receipts.get(id); return receipt ? outboxView(receipt) : undefined }
  }
}

/** A trigger: its threads, the tickets its disposition reached, and those tickets' outbound replies. */
function triggerView(deps: RecallDeps, trigger: Trigger): Loaded {
  const disposition = deps.store.triggers.disposition(trigger.id)
  const reached = new Set<string>([...(disposition?.fanout ?? []), ...(disposition?.acked ?? []), ...(disposition?.handbacks ?? []).map(item => item.ticketId)])
  for (const ticket of deps.store.tickets.list()) if (ticket.origin.triggerId === trigger.id) reached.add(ticket.id)
  const ticketIds = [...reached].filter(id => deps.store.tickets.get(id))
  const receipts = deps.store.read.outbox(ticketIds, NEXT_PER_KIND)
  const keys = trigger.threads.map(threadKey)
  const text = spillText(trigger.text, 'text')
  const view: RecallView = {
    id: trigger.id,
    kind: 'trigger',
    at: trigger.at,
    actor: `${trigger.actor.source}/${trigger.actor.id}`,
    human: trigger.human,
    thread: keys[0],
    summary: `[${trigger.actor.source}/${trigger.actor.id}] ${oneLine(trigger.text, 120)}`,
    text: text.text,
    ...(text.cursor ? { textCursor: text.cursor } : {}),
    tickets: ticketIds.slice(0, 2 * NEXT_PER_KIND),
    next: [
      ...keys.map(key => ({ kind: 'thread' as const, id: key, why: '所在会话' })),
      ...ticketIds.slice(0, NEXT_PER_KIND).map(id => ({ kind: 'ticket' as const, id, why: 'disposition 命中的工单' })),
      ...receipts.map(receipt => ({ kind: 'outbox' as const, id: receipt.id, why: '该工单的回复消息' })),
    ],
  }
  return { view, fields: { text: trigger.text }, spilled: text.spilled }
}

/**
 * A thread: the tickets on it (live and ended — subscriptions persist, and the thread's accept
 * decisions cover tickets that already unsubscribed) and its most recent triggers.
 */
function threadView(deps: RecallDeps, id: string): Loaded | undefined {
  const store = deps.store
  const thread = store.threads.get(id) ?? store.threads.list().find(candidate => candidate.ref.id === id || candidate.key.endsWith(`:${id}`))
  if (!thread) return undefined
  const tickets = new Set<string>([...thread.subscriptions, ...(thread.context ?? [])])
  for (const decision of store.decisions.byThread(thread.key)) if (decision.ticketId) tickets.add(decision.ticketId)
  const ticketIds = [...tickets].filter(tid => store.tickets.get(tid))
  const recent = store.read.threadTriggers(thread.key, NEXT_PER_KIND)
  const label = typeof thread.meta.label === 'string' ? thread.meta.label : undefined
  const view: RecallView = {
    id: thread.key,
    kind: 'thread',
    label,
    createdAt: thread.createdAt,
    lastAt: thread.lastAt,
    summary: `${label ? `${label}（` : ''}${thread.key}${label ? '）' : ''}：${ticketIds.length} 个工单、最近 ${recent.length} 条消息`,
    tickets: ticketIds.slice(0, 2 * NEXT_PER_KIND),
    next: [
      ...ticketIds.slice(0, NEXT_PER_KIND).map(tid => ({ kind: 'ticket' as const, id: tid, why: '该会话上的工单（含已结束）' })),
      ...recent.map(item => ({ kind: 'trigger' as const, id: item.id, why: '最近的触发消息' })),
    ],
  }
  return { view, fields: {}, spilled: 0 }
}

/** A ticket: its thread subscriptions, worker conversation, recent replies, origin trigger, watchdog verdict. */
function ticketView(deps: RecallDeps, ticket: Ticket): Loaded {
  const store = deps.store
  const assignment = ticket.assignments.at(-1)
  const report = assignment?.report
  const reportSpill = report ? spillText(report.summary, 'report') : undefined
  const conversationId = store.get(workerConversationKey(ticket.id))
  const receipts = store.read.outbox([ticket.id], NEXT_PER_KIND)
  const verdict = (store.get(KV.watchdog.verdicts(ticket.id)) ?? []).at(-1)
  const threads = new Set<string>(ticket.channels.map(channel => threadKey({ source: channel.source, id: channel.thread })))
  for (const thread of store.read.subscribedThreads()) if (thread.subscriptions.includes(ticket.id)) threads.add(thread.key)
  const state = ticket.ended ? `已结束（${ticket.ended.by}/${ticket.ended.outcome}）` : '进行中'
  const view: RecallView = {
    id: ticket.id,
    kind: 'ticket',
    title: ticket.title,
    state,
    assignment: assignment ? { id: assignment.id, state: assignment.state } : undefined,
    ...(reportSpill
      ? { report: { state: report!.state, at: report!.at, summary: reportSpill.text, ...(reportSpill.cursor ? { summaryCursor: reportSpill.cursor } : {}) } }
      : {}),
    ...(verdict ? { watchdog: { at: verdict.at, verdict: verdict.verdict, reason: verdict.reason, action: verdict.action } } : {}),
    ...(conversationId !== undefined ? { conversationId: String(conversationId) } : {}),
    summary: `「${ticket.title}」${state}；worker ${assignment?.state ?? '无'}${report ? `，最近上报 ${report.state}` : ''}；订阅 ${threads.size} 个会话`,
    next: [
      ...[...threads].slice(0, NEXT_PER_KIND).map(key => ({ kind: 'thread' as const, id: key, why: '订阅的会话' })),
      ...(conversationId !== undefined ? [{ kind: 'conversation' as const, id: String(conversationId), why: 'worker 会话' }] : []),
      ...receipts.map(receipt => ({ kind: 'outbox' as const, id: receipt.id, why: '最近的回复消息' })),
      ...(store.triggers.get(ticket.origin.triggerId) ? [{ kind: 'trigger' as const, id: ticket.origin.triggerId, why: '发起消息' }] : []),
    ],
  }
  return { view, fields: report ? { report: report.summary } : {}, spilled: reportSpill?.spilled ?? 0 }
}

/**
 * A worker conversation: its ticket, the recent entries as one-line summaries (never the whole
 * history), a capped total, and the newest assistant text as the summary.
 */
async function conversationView(deps: RecallDeps, id: string, context: Context): Promise<Loaded | undefined> {
  const ticketId = conversationTicket(deps, id)
  if (ticketId === undefined) return undefined
  const read = await deps.readConversation(id, CONVERSATION_RECENT_LIMIT, CONVERSATION_COUNT_CAP, context)
  if (!read) return undefined
  const lines = read.recent.map(activityLine).filter(Boolean)
  const assistant = newestAssistantText(read.recent)
  const summary = spillText(assistant || '（还没有助手输出）', 'summary')
  const view: RecallView = {
    id,
    kind: 'conversation',
    ticket: ticketId,
    total: read.total,
    ...(read.capped ? { totalCapped: true } : {}),
    recent: lines,
    summary: summary.text,
    ...(summary.cursor ? { summaryCursor: summary.cursor } : {}),
    next: [{ kind: 'ticket', id: ticketId, why: '所属工单' }],
  }
  return { view, fields: { summary: assistant }, spilled: summary.spilled }
}

/** The ticket whose worker conversation this is, by the KV key each worker conversation is recorded under. */
function conversationTicket(deps: RecallDeps, conversationId: string): string | undefined {
  for (const key of deps.store.keys('worker-conv:')) {
    if (String(deps.store.get(record<number>(key))) === conversationId) return key.slice('worker-conv:'.length)
  }
  return undefined
}

/** An outbound message receipt: what went out, to which thread and ticket, and its delivery status. */
function outboxView(receipt: Receipt): Loaded {
  const thread = threadKey({ source: receipt.channel.source, id: receipt.channel.thread })
  const text = spillText(receipt.text, 'text')
  const view: RecallView = {
    id: receipt.id,
    kind: 'outbox',
    ticketId: receipt.ticketId,
    status: receipt.status,
    ...(receipt.dropped ? { dropped: receipt.dropped } : {}),
    thread,
    summary: `${receipt.kind} → ${thread}${receipt.ticketId ? `（工单 ${receipt.ticketId}）` : ''}：${oneLine(receipt.text, 120)}`,
    text: text.text,
    ...(text.cursor ? { textCursor: text.cursor } : {}),
    next: [
      ...(receipt.ticketId ? [{ kind: 'ticket' as const, id: receipt.ticketId, why: '所属工单' }] : []),
      { kind: 'thread' as const, id: thread, why: '回复所在会话' },
    ],
  }
  return { view, fields: { text: receipt.text }, spilled: text.spilled }
}

/** The most recent ids of a kind, so an unknown id fails with better guesses than silence. */
function recentIdsOfKind(deps: RecallDeps, kind: RecallKind): string[] {
  const store = deps.store
  switch (kind) {
    case 'trigger': return store.read.recentTriggers(0, UNKNOWN_HINT_IDS).map(item => item.id)
    case 'thread': return store.threads.list().slice(-UNKNOWN_HINT_IDS).map((item: Thread) => item.key)
    case 'ticket': return store.tickets.list().slice(0, UNKNOWN_HINT_IDS).map(item => item.id)
    case 'conversation': {
      const ids = store.keys('worker-conv:').map(key => String(store.get(record<number>(key))))
      return [...new Set(ids)].slice(-UNKNOWN_HINT_IDS)
    }
    case 'outbox': return store.read.outbox([], UNKNOWN_HINT_IDS).map(item => item.id)
  }
}

/** Collapse whitespace and cut to `limit` characters, marking the cut. */
function oneLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/** The newest non-empty assistant text among `entries`, mirroring the transcript readers' extraction. */
function newestAssistantText(entries: EntryRecord[]): string {
  for (const entry of [...entries].reverse()) {
    if (entry.kind !== 'pi.assistant') continue
    const message = ((entry as { model?: unknown[] }).model ?? [])[0] as { content?: unknown } | undefined
    const content = message?.content
    const text = typeof content === 'string' ? content
      : Array.isArray(content)
        ? content.filter(part => (part as { type?: string })?.type === 'text').map(part => (part as { text?: string }).text ?? '').join('')
        : ''
    if (text.trim()) return text.trim()
  }
  return ''
}

/** Build the recall tool against one plugin instance; registered like the tools in `tools.ts`. */
export function createRecallTool(deps: RecallDeps) {
  return defineTool({
    name: RECALL_TOOL,
    description: '按 id 召回一个对象的有界视图（kind: trigger | thread | ticket | conversation | outbox），沿 next 里的引用链式召回（如 trigger → thread → ticket → conversation）。超长字段只内联头尾，用返回的 cursor 分页读全文。只读。',
    parameters: obj({
      kind: oneOf(RECALL_KINDS, { description: 'The kind of object to recall' }),
      id: str({ description: 'The object id (a thread is recalled by its key, a conversation by its conversation id)' }),
      cursor: opt(str({ description: 'Page a spilled field, e.g. "text:0" as shown in the view; omit for the object view' })),
    }),
    execute: async (args: RecallArgs, _api, context) => {
      const outcome = await recallObject(deps, args, context)
      if (outcome.isError) return { isError: true, output: [{ type: 'text', text: outcome.message }] }
      return { output: [{ type: 'text', text: JSON.stringify('view' in outcome.result ? outcome.result.view : outcome.result.page, null, 2) }] }
    },
  })
}
