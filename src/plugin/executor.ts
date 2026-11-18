/**
 * The plugin's Executor: the domain port that turns Assignments into durable worker tasks.
 *
 * The Engine calls `start` inside its commands (dispatch, retry, resume, restart recovery), so it
 * only queues. Launching creates one root `superagent.worker` task through a commit on the harness
 * the host bound — the pi-durable primitive, identical from a model-called dispatch and from
 * assessor-decided dispatches or restart recovery. The worker conversation is created by the task
 * itself (`tx.createConversation`, task-owned), never from a host closure.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord/context'
import type { Harness, Task } from '@earendil-works/pi-durable'
import type { Assignment, Engine, Executor, Ticket, TicketInput } from '../core/index.ts'
import type { Store } from '../app/store.ts'
import { workerTaskKey, type WorkerBridges, type WorkerTaskDeps, type WorkerTaskInput, type WorkerTaskState } from './worker.ts'

export interface ExecutorHost extends WorkerTaskDeps {
  readonly store: Store
  workerTask(): Task<WorkerTaskInput, WorkerTaskState, null, object>
  harness(): Harness | undefined
}

export class PluginExecutor implements Executor {
  private launching?: Promise<void>
  private readonly queue: { ticket: Ticket; assignment: Assignment }[] = []
  private closed = false

  constructor(private readonly host: ExecutorHost) {}

  /** Queue a pending assignment; the pump launches it as soon as the harness is bound. */
  start(ticket: Ticket, assignment: Assignment): void {
    if (this.closed) return
    this.queue.push({ ticket, assignment })
    void this.pump()
  }

  /** Hand a person's follow-up to the running worker conversation through its bridge. */
  deliver(ticket: Ticket, assignment: Assignment): void {
    const worker = this.host.bridges.get(ticket.id)
    if (!worker || worker.assignmentId !== assignment.id) return
    const ids = ticket.undelivered.filter(id => ticket.inputs.some(input => input.id === id))
    if (!ids.length) return
    const text = ids
      .map(id => inputText(this.host.store, ticket, ticket.inputs.find(input => input.id === id)))
      .filter(Boolean).join('\n\n')
    void worker.deliver(text)
      .then(() => this.host.engine().inputsDelivered(ticket.id, assignment.id, ids))
      .catch(error => this.host.cfg.log('input delivery failed', String(error)))
  }

  /** Ask the ticket's running worker to stop; the domain has already ended the assignment. */
  stop(ticket: Ticket, assignment: Assignment, reason: string): void {
    const worker = this.host.bridges.get(ticket.id)
    if (!worker || worker.assignmentId !== assignment.id) return
    this.host.cfg.log('stopping worker', `${ticket.id}: ${reason}`)
    worker.stop()
  }

  /** Wait until every queued launch has been created (used by the dispatch tool). */
  async drain(context: Context): Promise<void> {
    while (this.queue.length || this.launching) {
      await this.pump(context)
      if (this.launching) await this.launching
    }
  }

  close(): void {
    this.closed = true
    this.queue.length = 0
  }

  private async pump(context: Context = BACKGROUND_CONTEXT): Promise<void> {
    if (this.launching) return this.launching
    this.launching = this.drainQueue(context).finally(() => { this.launching = undefined })
    return this.launching
  }

  private async drainQueue(context: Context): Promise<void> {
    while (this.queue.length) {
      if (!this.host.harness()) return // not bound yet; the queue waits for bind()
      const { ticket, assignment } = this.queue.shift()!
      await this.launch(ticket, assignment, context).catch(error => {
        this.host.cfg.log('worker task creation failed', `${ticket.id}: ${String((error as Error)?.message ?? error)}`)
        try {
          this.host.engine().report(ticket.id, { state: 'failed', summary: `执行失败：worker task could not be created: ${String((error as Error)?.message ?? error)}`.slice(0, 1000) })
        } catch { /* ticket may have ended */ }
      })
    }
  }

  /** Create the assignment's worker task once; the KV record keeps a retry or rerun from doubling it. */
  private async launch(ticket: Ticket, assignment: Assignment, context: Context): Promise<void> {
    const key = workerTaskKey(assignment.id)
    const existing = this.host.store.get(key)
    const harness = this.host.harness()
    if (!harness) return
    if (existing) {
      const record = await harness.getTask(existing as never, context)
      if (record && record.state.status !== 'terminal') {
        this.host.cfg.log('worker task reused', `${ticket.id}/${assignment.id}`)
        return
      }
    }
    const input: WorkerTaskInput = { ticketId: ticket.id, assignmentId: assignment.id }
    // A background task owned by the root conversation: it never holds the router's runs, survives
    // restarts (the harness resumes reconciled pending tasks), and is rescheduled when its anchor
    // is touched — the KV record above keeps a retry or rerun from doubling it.
    const anchor = await harness.root(context)
    const taskId = await harness.commit(async tx => {
      return await tx.createTask(this.host.workerTask(), input, {
        ownership: { kind: 'conversation' },
        conversationId: anchor.id,
        background: true,
      })
    }, context)
    this.host.store.set(key, taskId)
    this.host.cfg.log('worker task created', { ticket: ticket.id, assignment: assignment.id, task: taskId })
  }
}

function inputText(store: Store, ticket: Ticket, input: TicketInput | undefined): string {
  if (!input) return ''
  if (input.kind === 'trigger') return store.triggers.get(input.triggerId)?.text ?? ''
  if (input.kind === 'text' || input.kind === 'note') return input.text
  return ''
}
