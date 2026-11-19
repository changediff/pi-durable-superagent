/**
 * The turn Watchdog: an independent durable conversation that babysits one running worker turn.
 *
 * The worker task runs each assignment as a single long turn (`raceTurn(submission.wait(...))`),
 * and until now nothing judged whether that turn is actually making progress — a stuck worker was
 * only discovered at the 30-minute timeout. The watchdog closes that gap without touching the
 * Router's intake: while the turn runs, every `intervalMs` it samples the worker conversation's
 * *recent* activity (never the whole transcript), asks its own model — in its own conversation,
 * keyed `watchdog-conv:<ticketId>` so the worker's context stays clean — for a structured verdict
 * (`advancing` / `stalled` / `looping` / `drifting`), records it in the store, and in mode `auto`
 * intervenes through the worker's `deliver()` channel. Two consecutive same-problem verdicts, or
 * an exhausted nudge budget, abort the turn; the runner (`worker.ts`) then reports `failed` on the
 * existing path. It never creates tickets or assignments, so it is supervision, not routing.
 */
import { configure, type ConversationHandle, type ConversationId, type EntryId } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import type { Ticket } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Store } from '../app/store.ts'
import type { ResolvedSuperagentWatchdogConfig } from './config.ts'
import { activityLines, lastAssistantText } from './transcript.ts'
import type { RunningWorker, WorkerRuntime, WorkerTask, WorkerTaskDeps } from './worker.ts'

export type WatchdogVerdictKind = 'advancing' | 'stalled' | 'looping' | 'drifting'
export interface WatchdogVerdict { verdict: WatchdogVerdictKind; reason: string }

/** What one completed check did: nothing (advancing), a store record (observe), a nudge, or an abort decision. */
export type WatchdogAction = 'none' | 'recorded' | 'nudge' | 'abort'

/** One stored watchdog judgement, newest last; see `KV.watchdog.verdicts`. */
export interface WatchdogVerdictRecord {
  at: string
  verdict: WatchdogVerdictKind
  reason: string
  interventions: number
  action: WatchdogAction
  idleMs: number
}

const PROBLEM_KINDS: readonly WatchdogVerdictKind[] = ['stalled', 'looping', 'drifting']
const PROBLEM_TEXT: Record<Exclude<WatchdogVerdictKind, 'advancing'>, string> = {
  stalled: '一段时间没有有效进展',
  looping: '在反复做同一件事或重复同一命令',
  drifting: '当前做的事偏离了工单目标',
}
/** How many verdict records are kept per ticket for later review. */
const VERDICT_HISTORY = 50

const WATCHDOG_INSTRUCTIONS = `你是超级智能体（super-agent）的 Watchdog（看护），负责判断一个 Worker 会话是否在真实推进。
你每次只看到该 Worker 会话的最近几条活动，以及距它上次活动过去的时间。你只做判断，不执行任务。
只输出一个 JSON 对象，不要输出任何其他文字。

判定规则：
- advancing：最近有实质新动作（新的工具调用、新的结果、向工单目标的实质推进）。
- stalled：距上次有效活动已较久，最近没有实质动作。
- looping：还在动，但在反复做同一件事或重复同一命令，没有新的结果。
- drifting：还在动，但做的事偏离了工单目标。

输出 JSON 结构：
{"verdict":"advancing"|"stalled"|"looping"|"drifting","reason":"一句不超过 120 字的中文说明"}`

const VERDICT_KIND_SET = new Set<string>(['advancing', 'stalled', 'looping', 'drifting'])

/** Parse the watchdog model's reply; anything that is not a valid verdict object is discarded, never guessed. */
export function parseWatchdogVerdict(text: string): WatchdogVerdict | undefined {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as { verdict?: unknown; reason?: unknown }
    if (typeof parsed.verdict !== 'string' || !VERDICT_KIND_SET.has(parsed.verdict)) return undefined
    return {
      verdict: parsed.verdict as WatchdogVerdictKind,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 120) : '',
    }
  } catch {
    return undefined
  }
}

/** Mutable per-turn state the verdict policy walks over; exported for tests. */
export interface WatchdogTurnState { interventions: number; lastProblem?: WatchdogVerdictKind }

/**
 * Apply one verdict to the turn: `advancing` clears the problem memory; a problem in `observe`
 * only records; in `auto` a *new* problem nudges once, while the same problem twice in a row (the
 * nudge did not help) or an exhausted nudge budget aborts.
 */
export function applyWatchdogVerdict(
  state: WatchdogTurnState, verdict: WatchdogVerdict, mode: 'observe' | 'auto', maxInterventions: number,
): WatchdogAction {
  if (!PROBLEM_KINDS.includes(verdict.verdict)) {
    state.lastProblem = undefined
    return 'none'
  }
  if (mode !== 'auto') return 'recorded'
  if (state.interventions >= maxInterventions || state.lastProblem === verdict.verdict) return 'abort'
  state.interventions += 1
  state.lastProblem = verdict.verdict
  return 'nudge'
}

/** The guardian nudge injected through the worker's `deliver()` channel: names the problem, never a bare "继续". */
export function watchdogNudgeText(verdict: WatchdogVerdict): string {
  if (verdict.verdict === 'advancing') return ''
  return [
    `【看护提示】Watchdog 判定：${PROBLEM_TEXT[verdict.verdict]}（${verdict.reason}）。`,
    '请立刻改变做法：先用一两句话说明你接下来要尝试的不同的方法，再继续执行；不要重复刚才做过的命令。',
    '如果你判断无法继续，立即调用 superagent_report 上报 blocked 或 failed，并写明原因。',
  ].join('\n')
}

/** The failure summary the runner reports when the watchdog aborts the turn. */
export function watchdogAbortSummary(verdict: WatchdogVerdict, state: WatchdogTurnState): string {
  return `watchdog 判定卡死（${verdict.verdict}：${verdict.reason}）；已干预 ${state.interventions} 次无效，中止本 turn`
}

/** The IO one watchdog loop needs; tests script these instead of driving real conversations. */
export interface TurnWatchdogIo {
  /** The worker's recent activity lines (oldest first) and the newest transcript entry id. */
  readActivity(): Promise<{ lines: string[]; tailId?: EntryId }>
  /** One model judgement of the sampled activity; `undefined` means no verdict this round. */
  judge(lines: string[], idleMs: number, signal: AbortSignal): Promise<WatchdogVerdict | undefined>
  /** Inject one guardian nudge through the worker's `deliver()` channel. */
  nudge(text: string): Promise<void>
}

export interface TurnWatchdogHost {
  settings: ResolvedSuperagentWatchdogConfig
  store: Store
  ticketId: string
  /** Aborted when the owning worker invocation ends, so the loop never outlives the turn. */
  lifetime?: AbortSignal
  log(message: string, detail?: unknown): void
  now(): string
}

export interface TurnWatchdog {
  /** Resolves with the failure summary once the watchdog decided the turn must be aborted. */
  readonly aborted: Promise<string>
  /** Stop checking, clear the interval timer, cancel the in-flight judgement; idempotent. */
  stop(): Promise<void>
  /** Completed (verdict-producing) checks so far. */
  readonly checks: number
}

/** A watchdog that never fires: what mode `off` runs with. */
export function idleTurnWatchdog(): TurnWatchdog {
  return {
    aborted: new Promise<string>(() => {}),
    stop: async () => {},
    checks: 0,
  }
}

/**
 * Run one watchdog loop against a worker turn. The loop samples every `settings.intervalMs` with a
 * plain (unref'd) timer, so it is pacing state inside the worker task's invocation — not durable
 * work of its own — and `stop()` (or the host `lifetime`) always clears the timer before resolving.
 */
export function runTurnWatchdog(host: TurnWatchdogHost, io: TurnWatchdogIo): TurnWatchdog {
  const { settings, ticketId } = host
  // Mode `off` never samples: the loop is not even started, so no judgement can happen.
  if (settings.mode === 'off') return idleTurnWatchdog()
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  let checks = 0
  const controller = new AbortController()
  const state: WatchdogTurnState = { interventions: 0 }
  let lastTail: EntryId | undefined
  let lastChangeAt = Date.now()
  let resolveAborted!: (summary: string) => void
  let resolveDone!: () => void
  const aborted = new Promise<string>(resolve => { resolveAborted = resolve })
  const done = new Promise<void>(resolve => { resolveDone = resolve })

  host.lifetime?.addEventListener('abort', () => { controller.abort() }, { once: true })
  const sleep = (ms: number): Promise<void> => new Promise(resolve => {
    timer = setTimeout(() => { timer = undefined; resolve() }, ms)
    timer.unref?.()
  })
  const signalled = new Promise<void>(resolve => controller.signal.addEventListener('abort', () => resolve(), { once: true }))

  const clearTimer = (): void => {
    if (timer) { clearTimeout(timer); timer = undefined }
  }

  void (async () => {
    try {
      while (!stopped) {
        await Promise.race([sleep(settings.intervalMs), signalled])
        if (stopped) break
        const sample = await io.readActivity()
        if (stopped) break
        // The sample cadence bounds idle detection: the tail moved since the last check counts as activity.
        if (sample.tailId !== undefined && sample.tailId !== lastTail) {
          lastTail = sample.tailId
          lastChangeAt = Date.now()
        }
        const idleMs = Date.now() - lastChangeAt
        const verdict = await io.judge(sample.lines, idleMs, controller.signal).catch(error => {
          host.log('watchdog check failed', String((error as Error)?.message ?? error))
          return undefined
        })
        if (stopped || verdict === undefined) continue
        checks += 1
        const action = applyWatchdogVerdict(state, verdict, settings.mode === 'observe' ? 'observe' : 'auto', settings.maxInterventions)
        host.log('watchdog', { ticketId, verdict: verdict.verdict, reason: verdict.reason, interventions: state.interventions })
        recordVerdict(host, { at: host.now(), verdict: verdict.verdict, reason: verdict.reason, interventions: state.interventions, action, idleMs })
        if (action === 'nudge') {
          const text = watchdogNudgeText(verdict)
          await io.nudge(text).catch(error => host.log('watchdog nudge failed', String((error as Error)?.message ?? error)))
        } else if (action === 'abort') {
          stopped = true
          clearTimer()
          controller.abort()
          resolveAborted(watchdogAbortSummary(verdict, state))
          break
        }
      }
    } finally {
      clearTimer()
      resolveDone()
    }
  })()

  return {
    aborted,
    get checks() { return checks },
    stop: async () => {
      if (stopped) { await done; return }
      stopped = true
      clearTimer()
      controller.abort()
      await done
    },
  }
}

function recordVerdict(host: TurnWatchdogHost, entry: WatchdogVerdictRecord): void {
  try {
    const key = KV.watchdog.verdicts(host.ticketId)
    const history = host.store.get(key) ?? []
    history.push(entry)
    host.store.set(key, history.slice(-VERDICT_HISTORY))
  } catch (error) {
    host.log('watchdog record failed', String((error as Error)?.message ?? error))
  }
}

/** Start the watchdog for one running worker turn; mode `off` returns the idle handle. */
export async function startWorkerWatchdog(
  deps: WorkerTaskDeps, ticket: Ticket, worker: RunningWorker, runtime: WorkerRuntime, context: Context,
): Promise<TurnWatchdog> {
  const settings = deps.cfg.watchdog
  if (settings.mode === 'off') return idleTurnWatchdog()
  const conversation = await watchdogConversation(deps, ticket, runtime, context)
  let seq = 0
  return runTurnWatchdog(
    {
      settings, store: deps.store, ticketId: ticket.id,
      lifetime: runtime.signal,
      log: deps.cfg.log,
      now: () => new Date().toISOString(),
    },
    {
      readActivity: async () => {
        const view = await runtime.context(worker.conversationId, context)
        return { lines: activityLines(view), tailId: view.entries.at(-1)?.id }
      },
      judge: async (lines, idleMs, signal) => {
        seq += 1
        return judgeWithConversation(deps, ticket, conversation, runtime, context, lines, idleMs, seq, signal)
      },
      nudge: async text => { await worker.nudge(text) },
    },
  )
}

/** Find (or create, task-owned) the ticket's watchdog conversation; keyed apart from the worker's. */
async function watchdogConversation(
  deps: WorkerTaskDeps, ticket: Ticket, runtime: WorkerRuntime, context: Context,
): Promise<ConversationHandle> {
  const key = KV.watchdog.conversation(ticket.id)
  const stored = deps.store.get(key)
  if (stored !== undefined) {
    const found = await runtime.conversation(stored as ConversationId, context)
    if (found) return found
  }
  let conversationId: ConversationId | undefined
  await runtime.commit(async tx => {
    const created = await tx.createConversation({ ownership: { kind: 'task', taskId: runtime.taskId } })
    await configure(tx, created.id, {
      model: { provider: deps.cfg.watchdog.model.provider, modelId: deps.cfg.watchdog.model.model },
      instructions: WATCHDOG_INSTRUCTIONS,
    })
    conversationId = created.id
    // Recorded inside the commit: a rollback leaves a dangling key that self-heals on the next start.
    deps.store.set(key, created.id)
  }, context)
  const id = conversationId!
  deps.cfg.log('watchdog conversation created', `${ticket.id} -> ${id}`)
  const handle = await runtime.conversation(id, context)
  if (!handle) throw new Error(`watchdog conversation ${ticket.id} missing from storage`)
  return handle
}

/** One judgement: submit the sampled activity to the watchdog conversation and parse its verdict. */
async function judgeWithConversation(
  deps: WorkerTaskDeps, ticket: Ticket, conversation: ConversationHandle, runtime: WorkerRuntime, context: Context,
  lines: string[], idleMs: number, seq: number, signal: AbortSignal,
): Promise<WatchdogVerdict | undefined> {
  const prompt = [
    `工单目标：${ticket.mandate.scope || ticket.title}`,
    `距上次活动：${Math.round(idleMs / 1000)} 秒`,
    'Worker 会话最近的活动（从旧到新）：',
    ...(lines.length ? lines : ['（还没有任何活动）']),
    '',
    '请输出 JSON。',
  ].join('\n')
  const submission = await conversation.submit(
    { type: 'input', content: prompt, requestId: `superagent:watchdog:${ticket.id}:${seq}` },
    context,
  )
  const signalled = new Promise<'signalled'>(resolve => signal.addEventListener('abort', () => resolve('signalled'), { once: true }))
  const settled = await Promise.race([
    submission.wait(context).then(value => ({ kind: 'settled' as const, value })),
    signalled.then(() => ({ kind: 'signalled' as const })),
  ])
  if (settled.kind === 'signalled') {
    // The turn ended mid-judgement: kill this run of our own conversation and drop the verdict.
    await conversation.abort(context).catch(error => deps.cfg.log('watchdog judgement abort failed', String((error as Error)?.message ?? error)))
    return undefined
  }
  if (settled.value.status !== 'done' || settled.value.type !== 'input') return undefined
  const text = await lastAssistantText(runtime, conversation.id, context)
  const verdict = parseWatchdogVerdict(text)
  if (!verdict) deps.cfg.log('watchdog verdict unparseable', text.slice(0, 200))
  return verdict
}
