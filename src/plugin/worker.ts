/**
 * The plugin's durable worker: one `superagent.worker` task per Assignment.
 *
 * DSH's executor held worker conversations on a host-closed harness. The plugin instead runs each
 * worker as a durable task the dispatch tool (or the host-bound harness, for assessor-driven
 * dispatches) creates; the task owns its conversation (`tx.createConversation` inside its own
 * commit), drives one turn per Assignment, and reports back through the same Engine callbacks.
 * Because the task checkpoints at every step, a restarted process resumes it instead of losing the
 * worker; the domain's `hostRestarted` recovery still applies when the task could not resume.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { AssistantEntry, configure, defineTask, type ConversationHandle, type ConversationId, type RunningTask, type TaskRuntime, type Tx } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'
import { liveTicket, runningAssignment, type Engine, type Ticket } from '../core/index.ts'
import { record } from '../kv.ts'
import type { Store } from '../app/store.ts'
import type { ResolvedSuperagentConfig } from './config.ts'

/** How long a queued worker task waits between worker-slot checks. */
const SLOT_POLL_MS = 1500

export interface WorkerTaskDeps {
  readonly store: Store
  readonly cfg: ResolvedSuperagentConfig
  engine(): Engine
  bridges: WorkerBridges
}

/** Input of one `superagent.worker` task: the assignment it runs. */
export interface WorkerTaskInput { ticketId: string; assignmentId: string }
/** The worker task has a single phase that re-runs from its top after a restart or a slot wait. */
export interface WorkerTaskState { phase: 'run' }

type WorkerRuntime = TaskRuntime<WorkerTaskInput, WorkerTaskState, null, object>
type WorkerTask = RunningTask<WorkerTaskInput, WorkerTaskState, null>

/**
 * In-memory bridge between the domain Executor (synchronous, host-side) and the running worker
 * task that owns the conversation: follow-up delivery and stop requests cross it. Registered for
 * the lifetime of one worker turn; a restart re-registers when the task resumes.
 */
export class WorkerBridges {
  private readonly byTicket = new Map<string, RunningWorker>()
  private readonly byConversation = new Map<ConversationId, string>()

  register(worker: RunningWorker): void {
    this.byTicket.set(worker.ticketId, worker)
    this.byConversation.set(worker.conversationId, worker.ticketId)
  }

  release(ticketId: string): void {
    const worker = this.byTicket.get(ticketId)
    this.byTicket.delete(ticketId)
    if (worker && this.byConversation.get(worker.conversationId) === ticketId) this.byConversation.delete(worker.conversationId)
  }

  get(ticketId: string): RunningWorker | undefined { return this.byTicket.get(ticketId) }
  ticketOf(conversationId: ConversationId): string | undefined { return this.byConversation.get(conversationId) }
  stopAll(): void { for (const worker of this.byTicket.values()) worker.stop() }
}

/** One running worker turn, as the Executor sees it. */
export interface RunningWorker {
  readonly ticketId: string
  readonly assignmentId: string
  readonly conversationId: ConversationId
  /** Resolves once the domain asks the work to stop; the task then aborts the conversation quietly. */
  readonly stopped: Promise<void>
  stop(): void
  /** Submit a person's follow-up input to the worker conversation. */
  deliver(text: string): Promise<void>
}

/** Count the assignments the domain currently records as running (the worker-slot occupancy). */
export function runningAssignments(store: Store): number {
  let running = 0
  for (const ticket of store.tickets.active()) if (runningAssignment(ticket)) running++
  return running
}

/** The KV key under which a ticket's worker conversation id is kept across restarts. */
export const workerConversationKey = (ticketId: string) => record<number>(`worker-conv:${ticketId}`)
/** The KV key under which an assignment's worker task id is kept, so a relaunch reuses it. */
export const workerTaskKey = (assignmentId: string) => record<number>(`worker-task:${assignmentId}`)

const WORKER_INSTRUCTIONS = `你是超级智能体（super-agent）的 Worker，负责在一个独立工单里完成具体任务。
- 你能读写文件、执行 bash；任务需要查资料时优先用 curl 或已安装的 CLI。
- 只做工单范围内的事，不擅自扩大范围，不改与任务无关的文件。
- 完成或遇到无法继续的阻塞时，用一段简洁中文说明结果、改了什么、验证了什么、还剩什么。
- 无法继续时也可以调用 superagent_report 工具上报 blocked / failed；这段最终说明会直接发回用户。`

/** Build the first brief a worker conversation receives for an assignment. */
export function workerBrief(store: Store, cfg: ResolvedSuperagentConfig, ticket: Ticket): string {
  const origin = store.triggers.get(ticket.origin.triggerId)
  const parts = [
    `# 工单：${ticket.title}`,
    `目标：${ticket.mandate.scope || ticket.title}`,
    origin ? `\n发起人消息：\n${origin.text}` : '',
    '',
    '要求：',
    '1. 直接动手完成任务，不要只给建议。可以用 read/write/edit/bash 工具。',
    `2. 工作目录：${join(cfg.workDir, 'superagent', ticket.id)}（已创建）。需要联网时用 curl 或 gh。`,
    '3. 完成后用一条简洁的中文消息给出最终结果，这段文字会原样发回给用户。',
    '4. 正常完成不要调用任何工具，直接输出最终说明即可；只有在无法继续时才调用 superagent_report 上报 blocked 或 failed。',
    '5. 不要重复发起人已经说明的内容；不要输出中间过程。',
  ]
  return parts.filter(Boolean).join('\n')
}

/**
 * The durable worker task. One phase, re-run from its top after a restart or a slot wait:
 * validate the assignment still runs, claim a worker slot (atomically with
 * `Engine.assignmentStarted`), find or create the task-owned conversation, submit the brief, and
 * report the turn's outcome through the Engine exactly as the host executor did.
 */
export function createWorkerTask(deps: WorkerTaskDeps) {
  return defineTask<WorkerTaskInput, WorkerTaskState, null>({
    name: 'superagent.worker',
    version: 1,
    initial: () => ({ phase: 'run' }),
    phases: {
      run: async (task, runtime, context) => await runWorker(deps, task, runtime, context),
    },
    abort: async (task, runtime, context) => {
      deps.bridges.get(task.input.ticketId)?.stop()
      const stored = deps.store.get(workerConversationKey(task.input.ticketId))
      if (stored) {
        const handle = await runtime.conversation(stored as ConversationId, context)
        await handle?.abort(context).catch(error => deps.cfg.log('worker abort failed', String(error)))
      }
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), context).catch(() => {})
    },
  })
}

async function runWorker(deps: WorkerTaskDeps, task: WorkerTask, runtime: WorkerRuntime, context: Context): Promise<void> {
  const { store, cfg, engine, bridges } = deps
  const { ticketId, assignmentId } = task.input
  const ticket = store.tickets.get(ticketId)
  const assignment = ticket?.assignments.at(-1)
  if (!ticket || !liveTicket(ticket) || assignment?.id !== assignmentId
    || (assignment.state !== 'pending' && assignment.state !== 'running')) {
    // Superseded (restarted, retried, ended) before this task ran again: nothing to do.
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context)
    return
  }
  const handle = await workerConversation(deps, task, ticket, runtime, context)
  const stop = { request: () => {} }
  const stopped = new Promise<void>(resolve => { stop.request = resolve })
  let stopRequested = false
  const worker: RunningWorker = {
    ticketId, assignmentId, conversationId: handle.id, stopped,
    stop: () => { stopRequested = true; stop.request() },
    deliver: async text => { await handle.submit({ type: 'input', content: `用户追加：\n${text}` }, context) },
  }
  bridges.register(worker)
  try {
    if (assignment.state === 'pending') {
      // Claim a slot together with marking the assignment running, so two queued tasks cannot overshoot the cap.
      const claimed = store.atomic(() => {
        if (runningAssignments(store) > cfg.maxWorkers) return false
        engine().assignmentStarted(ticketId, assignmentId)
        return true
      })
      if (!claimed) {
        await runtime.sleepUntil(runtime.now() + SLOT_POLL_MS, { phase: 'run' }, context)
        return
      }
      cfg.log('worker started', `${ticketId}/${assignmentId} -> ${handle.id}`)
    }
    const brief = workerBrief(store, cfg, ticket)
    const submission = await handle.submit(
      { type: 'input', content: brief, requestId: `superagent:brief:${ticketId}:${assignmentId}` },
      context,
    )
    const settled = await raceTurn(submission.wait(context), stopped, cfg.workerTurnTimeoutMs)
    if (settled.kind === 'stopped') {
      cfg.log('worker stopped', `${ticketId}: by the domain`)
      await handle.abort(context).catch(error => cfg.log('worker abort failed', String(error)))
    } else if (settled.kind === 'timeout') {
      const detail = `worker timed out after ${Math.round(cfg.workerTurnTimeoutMs / 60000)} min`
      cfg.log('worker timed out', ticketId)
      await handle.abort(context).catch(() => {})
      report(deps, ticketId, { state: 'failed', summary: `执行失败：${detail}`.slice(0, 1000) })
    } else if (settled.value.status === 'done' && settled.value.type === 'input') {
      const summary = await lastAssistantText(runtime, handle.id, context) || '已完成，但没有文本输出。'
      cfg.log('worker finished', `${ticketId}: ${summary.length} chars`)
      report(deps, ticketId, { state: 'ready', summary })
      // The DSH build's main Session called orchestrator_reply; the plugin sends the result itself.
      try { engine().reply({ purpose: 'result', ticketId, text: summary }) }
      catch (error) { cfg.log('result reply refused', String((error as Error)?.message ?? error)) }
    } else if (!stopRequested) {
      const reason = 'reason' in settled.value ? ` (${String(settled.value.reason)})` : ''
      report(deps, ticketId, { state: 'failed', summary: `执行失败：worker turn ended as ${settled.value.status}${reason}`.slice(0, 1000) })
    }
  } catch (error) {
    if (!stopRequested) {
      const detail = String((error as Error)?.message ?? error)
      deps.cfg.log('worker failed', `${ticketId}: ${detail}`)
      report(deps, ticketId, { state: 'failed', summary: `执行失败：${detail}`.slice(0, 1000) })
    }
  } finally {
    bridges.release(ticketId)
    await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), context).catch(() => {})
  }
}

/** Find (or create, task-owned) the ticket's worker conversation; reused across assignments and restarts. */
async function workerConversation(
  deps: WorkerTaskDeps, task: WorkerTask, ticket: Ticket, runtime: WorkerRuntime, context: Context,
): Promise<ConversationHandle> {
  const { store, cfg } = deps
  const key = workerConversationKey(ticket.id)
  const stored = store.get(key)
  if (stored) {
    const found = await runtime.conversation(stored as ConversationId, context)
    if (found) return found
  }
  const directory = join(cfg.workDir, 'superagent', ticket.id)
  await mkdir(directory, { recursive: true })
  let conversationId: ConversationId | undefined
  await runtime.commit(async tx => {
    // Crash-safe reuse: the ownership index remembers the conversation this task created.
    const existing = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0]
    if (existing) { conversationId = existing.id; return }
    const created = await tx.createConversation({ ownership: { kind: 'task', taskId: task.id } })
    await configure(tx, created.id, {
      model: { provider: cfg.worker.provider, modelId: cfg.worker.model },
      cwd: directory,
      instructions: WORKER_INSTRUCTIONS,
    })
    conversationId = created.id
  }, context)
  const id = conversationId!
  store.set(key, id)
  cfg.log('worker conversation created', `${ticket.id} -> ${id}`)
  const handle = await runtime.conversation(id, context)
  if (!handle) throw new Error(`worker conversation ${ticket.id} missing from storage`)
  return handle
}

/** Await a worker turn against stop and timeout, the way the host executor raced its controller. */
async function raceTurn(wait: Promise<unknown>, stopped: Promise<void>, timeoutMs: number):
  Promise<{ kind: 'settled'; value: { status: string; type?: string; reason?: string } } | { kind: 'stopped' } | { kind: 'timeout' }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([
      Promise.resolve(wait).then(value => ({ kind: 'settled' as const, value: value as { status: string; type?: string } })),
      stopped.then(() => ({ kind: 'stopped' as const })),
      timedOut.then(kind => ({ kind: kind as 'timeout' })),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Report through the Engine; an ended ticket (a person stopped it, an earlier report settled it) is not an error. */
function report(deps: WorkerTaskDeps, ticketId: string, value: { state: 'ready' | 'failed'; summary: string }): void {
  try { deps.engine().report(ticketId, value) }
  catch { /* ticket may have ended */ }
}

/** The newest non-empty assistant text of a worker conversation: the message sent back as the result. */
async function lastAssistantText(runtime: WorkerRuntime, conversationId: ConversationId, context: Context): Promise<string> {
  const view = await runtime.context(conversationId, context)
  for (const entry of [...view.entries].reverse()) {
    const isAssistant = (typeof AssistantEntry?.is === 'function' && AssistantEntry.is(entry)) || entry.kind === 'pi.assistant'
    if (!isAssistant) continue
    const message = ((entry as { model?: unknown[] }).model ?? [])[0] as { content?: { type: string; text?: string }[] }
    const text = (message?.content ?? []).filter(part => part?.type === 'text').map(part => part.text ?? '').join('')
    if (text.trim()) return text.trim()
  }
  return ''
}

export type { WorkerRuntime, WorkerTask }
