/**
 * pi-durable Executor: one nullable-owner durable conversation per Ticket, replacing `src/executor/dsh.ts`.
 *
 * DSH's executor managed a persistent DSH worker Session plus a workspace directory per ticket. The port
 * keeps the same shape on `@earendil-works/pi-durable`: `harness.createConversation()` per ticket, the
 * CodingTools extension (read/write/edit/bash) as the worker's toolset, JSONL storage for crash-resume, and
 * the ticket's own directory as cwd. Reports go back through `Engine.report`, so a crashed host can resume
 * the conversation without losing the ticket state machine in SQLite.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Harness, createRegistry, AssistantEntry } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Assignment, EngineForExecutor, Executor, Ticket, TicketInput } from '../core/index.ts'
import { KV, record } from '../kv.ts'
import type { Store } from '../app/store.ts'
import type { Config } from './config.ts'
import { buildModels } from './models.ts'

const TURN_TIMEOUT_MS = Number(process.env.SUP_TURN_TIMEOUT_MS || 30 * 60_000)

export interface ExecutorHost {
  readonly store: Store
  readonly engine: Pick<EngineForExecutor, 'assignmentStarted' | 'inputsDelivered' | 'report' | 'assignmentInterrupted'>
    & { reply(request: { purpose: 'result'; ticketId: string; text: string }): unknown }
  readonly cfg: Config
  log(message: string, detail?: unknown): void
}

type Conversation = Awaited<ReturnType<Harness['createConversation']>>

export class PiExecutor implements Executor {
  private harness?: Harness
  private readonly running = new Map<string, { conversation: Conversation; assignmentId: string; controller: AbortController }>()
  private readonly queue: { ticket: Ticket; assignment: Assignment }[] = []
  private closed = false

  constructor(private readonly host: ExecutorHost) {}

  /** Opens JSONL storage, installs CodingTools, and resumes any run the previous process left unfinished. */
  async open(): Promise<void> {
    const { cfg } = this.host
    await mkdir(cfg.harnessDir, { recursive: true })
    const storage = await openNodeJsonlStorage(cfg.harnessDir, BACKGROUND_CONTEXT, { fsync: true })
    const registry = createRegistry()
    registry.install(CodingTools)
    this.harness = await Harness.open(storage, {
      models: buildModels(cfg),
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd || cfg.workDir }),
    }, BACKGROUND_CONTEXT)
    this.harness.resume()
    this.host.log('pi-durable harness open', cfg.harnessDir)
  }

  async close(): Promise<void> {
    this.closed = true
    for (const entry of this.running.values()) entry.controller.abort()
    this.running.clear()
    this.queue.length = 0
  }

  /** Queue a pending assignment; the pump launches it as soon as a worker slot frees up. */
  start(ticket: Ticket, assignment: Assignment): void {
    if (this.closed) return
    this.queue.push({ ticket, assignment })
    void this.pump()
  }

  /** Hand a person's follow-up to the running worker conversation. */
  deliver(ticket: Ticket, assignment: Assignment): void {
    const entry = this.running.get(ticket.id)
    if (!entry || entry.assignmentId !== assignment.id) return
    const ids = ticket.undelivered.filter(id => ticket.inputs.some(input => input.id === id))
    if (!ids.length) return
    const text = ids.map(id => inputText(this.host.store, ticket, ticket.inputs.find(input => input.id === id))).filter(Boolean).join('\n\n')
    void this.submit(entry.conversation, `用户追加：\n${text}`)
      .then(() => this.host.engine.inputsDelivered(ticket.id, assignment.id, ids))
      .catch(error => this.host.log('input delivery failed', String(error)))
  }

  /** Abort the ticket's conversation when the domain asks the work to stop. */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    const entry = this.running.get(ticket.id)
    if (!entry || entry.assignmentId !== assignment.id) return
    this.host.log('stopping worker', `${ticket.id}: ${reason}`)
    entry.controller.abort()
  }

  private async pump(): Promise<void> {
    if (this.closed) return
    while (this.running.size < this.host.cfg.maxWorkers && this.queue.length) {
      const next = this.queue.shift()!
      void this.launch(next.ticket, next.assignment)
    }
  }

  private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
    const { cfg, engine } = this.host
    const directory = join(cfg.workDir, 'superagent', ticket.id)
    await mkdir(directory, { recursive: true })
    const controller = new AbortController()
    let conversation: Conversation | undefined
    try {
      conversation = await this.conversationFor(ticket, directory)
      this.running.set(ticket.id, { conversation, assignmentId: assignment.id, controller })
      engine.assignmentStarted(ticket.id, assignment.id)
      const settled = await this.submit(conversation, this.brief(ticket), controller.signal)
      if (!settled) throw new Error(`worker turn ended as ${settled === undefined ? 'timeout' : 'not done'}`)
      const summary = await lastAssistantText(conversation, controller.signal) || '已完成，但没有文本输出。'
      this.host.log('worker finished', `${ticket.id}: ${summary.length} chars`)
      engine.report(ticket.id, { state: 'ready', summary })
      // The DSH build's main Session called orchestrator_reply; the port sends the result itself.
      try { engine.reply({ purpose: 'result', ticketId: ticket.id, text: summary }) }
      catch (error) { this.host.log('result reply refused', String((error as Error)?.message ?? error)) }
    } catch (error) {
      if (!controller.signal.aborted) {
        const detail = String((error as Error)?.message ?? error)
        this.host.log('worker failed', `${ticket.id}: ${detail}`)
        try { engine.report(ticket.id, { state: 'failed', summary: `执行失败：${detail}`.slice(0, 1000) }) } catch { /* ticket may have ended */ }
      }
    } finally {
      this.running.delete(ticket.id)
      void this.pump()
    }
  }

  private async conversationFor(ticket: Ticket, directory: string): Promise<Conversation> {
    const harness = this.harness
    if (!harness) throw new Error('harness not open')
    const key = record<number>(`worker-conv:${ticket.id}`)
    const existing = this.host.store.get(key)
    if (existing) {
      const found = await harness.conversation(existing as never, BACKGROUND_CONTEXT)
      if (found) return found
    }
    const conversation = await harness.createConversation({
      ownership: { kind: 'ownerless' },
      agent: {
        model: { provider: this.host.cfg.workerProvider, modelId: this.host.cfg.workerModel },
        cwd: directory,
        instructions: WORKER_INSTRUCTIONS,
      },
    }, BACKGROUND_CONTEXT)
    this.host.store.set(key, conversation.id as unknown as number)
    this.host.log('worker conversation created', `${ticket.id} -> ${conversation.id}`)
    return conversation
  }

  /** Submit one input and wait for the durable turn to settle; false when it did not finish cleanly. */
  private async submit(conversation: Conversation, text: string, signal?: AbortSignal): Promise<boolean> {
    const submission = await conversation.submit({ type: 'input', content: text }, BACKGROUND_CONTEXT)
    const settled = await Promise.race([
      submission.wait(BACKGROUND_CONTEXT),
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), TURN_TIMEOUT_MS)),
    ])
    if (settled === 'timeout') {
      await conversation.abort(BACKGROUND_CONTEXT).catch(() => {})
      throw new Error(`worker timed out after ${Math.round(TURN_TIMEOUT_MS / 60000)} min`)
    }
    return settled.status === 'done' && settled.type === 'input'
  }

  private brief(ticket: Ticket): string {
    const origin = this.host.store.triggers.get(ticket.origin.triggerId)
    const parts = [
      `# 工单：${ticket.title}`,
      `目标：${ticket.mandate.scope || ticket.title}`,
      origin ? `\n发起人消息：\n${origin.text}` : '',
      '',
      '要求：',
      '1. 直接动手完成任务，不要只给建议。可以用 read/write/edit/bash 工具。',
      `2. 工作目录：${join(this.host.cfg.workDir, 'superagent', ticket.id)}（已创建）。需要联网时用 curl 或 gh。`,
      '3. 完成后用一条简洁的中文消息给出最终结果，这段文字会原样发回飞书给用户。',
      '4. 不要重复发起人已经说明的内容；不要输出中间过程。',
    ]
    return parts.filter(Boolean).join('\n')
  }
}

const WORKER_INSTRUCTIONS = `你是超级智能体（super-agent）的 Worker，负责在一个独立工单里完成具体任务。
- 你能读写文件、执行 bash；任务需要查资料时优先用 curl 或已安装的 CLI。
- 只做工单范围内的事，不擅自扩大范围，不改与任务无关的文件。
- 完成或遇到无法继续的阻塞时，用一段简洁中文说明结果、改了什么、验证了什么、还剩什么。
- 这段最终说明会直接发回飞书给用户。`

async function lastAssistantText(conversation: Conversation, signal?: AbortSignal): Promise<string> {
  const page = await conversation.entries({}, 10, undefined, BACKGROUND_CONTEXT)
  for (const entry of page.items) {
    const isAssistant = (typeof AssistantEntry?.is === 'function' && AssistantEntry.is(entry)) || (entry as { kind?: string })?.kind === 'pi.assistant'
    if (!isAssistant) continue
    const message = ((entry as { model?: unknown[] }).model ?? [])[0] as { content?: { type: string; text?: string }[] }
    const text = (message?.content ?? []).filter(part => part?.type === 'text').map(part => part.text ?? '').join('')
    if (text.trim()) return text.trim()
  }
  return ''
}

function inputText(store: Store, ticket: Ticket, input: TicketInput | undefined): string {
  if (!input) return ''
  if (input.kind === 'trigger') return store.triggers.get(input.triggerId)?.text ?? ''
  if (input.kind === 'text' || input.kind === 'note') return input.text
  return ''
}

export { KV }
