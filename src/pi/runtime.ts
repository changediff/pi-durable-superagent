/**
 * Composition root of the pi-durable port.
 *
 * DSH's `Runtime` was a Cordis Service that mounted the web panel, session controller, workspace registry
 * and tool surface. The port needs none of that: it opens the same SQLite domain store, wires the same
 * Engine with pi-durable adapters (GLM assessor, durable worker executor, Feishu outbox/source), and runs
 * two-second passes. Everything the panel used to show is in `docker logs` and the SQLite file.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { Engine, type Trigger } from '../core/index.ts'
import { settingsPolicy } from '../policy.ts'
import { Store } from '../app/store.ts'
import { Effects } from '../app/effects.ts'
import { Passes } from '../app/passes.ts'
import { HealthBoard } from '../infra/health.ts'
import type { Config } from './config.ts'
import { FeishuSource } from './feishu.ts'
import type { ChannelPort } from './channel.ts'
import { FeishuOutbox } from './outbox.ts'
import { GlmAssessor } from './assessor.ts'
import { PiExecutor } from './executor.ts'

export interface RuntimeOptions {
  log?: (message: string, detail?: unknown) => void
  /** Injected for `--selftest`; defaults to the Feishu WebSocket source. */
  channel?: ChannelPort
}

export class PiSuperagentRuntime {
  readonly store: Store
  readonly channel: ChannelPort
  readonly effects: Effects
  readonly engine: Engine
  readonly executor: PiExecutor
  readonly outbox: FeishuOutbox
  readonly assessor: GlmAssessor
  readonly passes: Passes

  private readonly board = new HealthBoard()
  private readonly lifetime = new AbortController()
  private release?: () => void
  private closed = false

  constructor(readonly cfg: Config, private readonly options: RuntimeOptions = {}) {
    const log = this.log.bind(this)
    mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
    this.release = lockSync(cfg.stateDir, { stale: 30_000 })
    this.store = new Store(join(cfg.stateDir, 'orchestrator.sqlite'), error => log('store', String(error)))
    this.bootstrapSettings()
    this.effects = new Effects(this.store, this.board)
    this.channel = this.options.channel ?? new FeishuSource(cfg, { onTrigger: trigger => this.onTrigger(trigger), log })
    this.outbox = new FeishuOutbox({
      store: this.store,
      effects: this.effects,
      channel: this.channel,
      paused: () => this.store.settings().paused,
      log,
    })
    const engineRef: { current?: Engine } = {}
    this.assessor = new GlmAssessor(cfg, {
      decide: (triggerId, outcome) => engineRef.current?.decide(triggerId, outcome),
      log,
    })
    this.executor = new PiExecutor({
      store: this.store,
      cfg,
      log,
      engine: {
        assignmentStarted: (ticketId, assignmentId) => engineRef.current?.assignmentStarted(ticketId, assignmentId),
        inputsDelivered: (ticketId, assignmentId, ids) => engineRef.current?.inputsDelivered(ticketId, assignmentId, ids),
        report: (ticketId, report) => engineRef.current!.report(ticketId, report),
        assignmentInterrupted: (ticketId, assignmentId) => engineRef.current?.assignmentInterrupted(ticketId, assignmentId),
        reply: request => engineRef.current?.reply(request),
      },
    })
    const scope = { scope: (input: { source: string; meta: Record<string, unknown> }) => this.channel.scope(input) }
    this.engine = new Engine({
      repo: this.store,
      policy: () => settingsPolicy(this.store.settings(), scope),
      scope,
      assessor: this.assessor,
      executor: this.executor,
      outbox: this.outbox,
      prepareTicket: ticket => ticket,
    })
    engineRef.current = this.engine
    this.passes = new Passes({
      engine: this.engine,
      effects: this.effects,
      health: this.board.claim('passes', { state: 'starting', detail: '' }),
      lifetime: this.lifetime.signal,
      configured: () => true,
      closing: () => this.closed,
    })
  }

  async start(): Promise<void> {
    // Effects only dispatch between start() and drain(); queued receipts wait until then.
    this.effects.start()
    await this.executor.open()
    this.recover()
    this.passes.start()
    // Long connections are the only inbound path; a failed start must fail the process, not idle silently.
    await this.channel.start?.()
    this.board.claim('runtime', { state: 'ready', detail: 'super-agent ready', at: new Date().toISOString() })
    this.log('runtime ready', {
      state: this.cfg.stateDir,
      evalMode: this.store.settings().eval.mode,
      model: `${this.cfg.provider}/${this.cfg.model}`,
      worker: `${this.cfg.workerProvider}/${this.cfg.workerModel}`,
    })
  }

  /** Feed one Trigger through the same path the Feishu WebSocket uses (selftest and local dispatch). */
  inject(trigger: Trigger): void {
    this.onTrigger(trigger)
  }

  private onTrigger(trigger: Trigger): void {
    try {
      const result = this.passes.receive(trigger)
      this.log('trigger received', { id: trigger.id, actor: trigger.actor.id, result })
    } catch (error) {
      this.log('trigger refused', String((error as Error)?.message ?? error))
    }
  }

  /** Assignments left `running` by a previous process were interrupted; the domain records it for retry. */
  private recover(): void {
    for (const ticket of this.store.tickets.active()) {
      const assignment = ticket.assignments.at(-1)
      if (assignment?.state === 'running') {
        this.engine.assignmentInterrupted(ticket.id, assignment.id)
        this.log('interrupted assignment recovered', `${ticket.id}/${assignment.id}`)
      }
    }
  }

  /** Seed the first settings revision from env: eval mode, worker cap and the Feishu sender allow-list. */
  private bootstrapSettings(): void {
    if (this.store.settingsHistory(1).length) return
    const current = this.store.settings()
    this.store.saveSettings({
      ...current,
      eval: { ...current.eval, mode: this.cfg.evalMode },
      executor: { ...current.executor, maxWorkers: this.cfg.maxWorkers },
      policy: {
        ...current.policy,
        sources: {
          ...current.policy.sources,
          feishu: {
            ...(current.policy.sources.feishu ?? {}),
            allowed: this.cfg.allowedOpenIds.map(id => ({ id })),
            allowAll: this.cfg.allowAll,
            admission: { group: { listedUnaddressed: this.cfg.unaddressedAdmission } },
          },
        },
      },
    }, { source: 'internal', policyVersion: '', policyChanged: true, notified: [] })
    this.log('settings seeded', { evalMode: this.cfg.evalMode, allowAll: this.cfg.allowAll })
  }

  async stop(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.passes.stop()
    await this.effects.drain().catch(() => {})
    await this.executor.close()
    await this.channel.stop?.()
    this.store.close()
    this.release?.()
    this.log('runtime stopped')
  }

  private log(message: string, detail?: unknown): void {
    if (this.options.log) this.options.log(message, detail)
    else if (detail === undefined) console.log(`[superagent] ${message}`)
    else console.log(`[superagent] ${message}`, typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
}