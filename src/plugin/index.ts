/**
 * The super-agent as a pi-durable extension.
 *
 * `createSuperagentExtension(config)` bundles the whole Router/Worker domain (Tickets, Mandates,
 * admission, outbox, passes — the unchanged `src/core` + `src/app` code) behind one
 * `defineExtension()` result named `superagent`, so any pi-durable Harness can install it:
 *
 * ```ts
 * const superagent = createSuperagentExtension({ ...config, channel: { send } })
 * const registry = createRegistry()
 * registry.install(CodingTools)
 * registry.install(superagent)
 * const harness = await Harness.open(storage, { models, registry, env }, context)
 * superagent.bind(harness)
 * await superagent.start()
 * superagent.ingest(trigger) // feed an inbound trigger (the host's Feishu source does this)
 * ```
 *
 * The plugin never imports Feishu: delivery is the `channel.send` callback the host supplies.
 * Worker conversations are created by the durable `superagent.worker` task from inside the
 * dispatch tool (`api.createTask` / `tx.createConversation`), never from a host closure.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { defineExtension, section, type Extension, type Harness } from '@earendil-works/pi-durable'
import { Engine, liveTicket, type ScopeResult, type Trigger } from '../core/index.ts'
import { settingsPolicy } from '../policy.ts'
import { Store } from '../app/store.ts'
import { Effects } from '../app/effects.ts'
import { Passes } from '../app/passes.ts'
import { HealthBoard } from '../infra/health.ts'
import { GlmAssessor } from '../pi/assessor.ts'
import { FeishuOutbox } from '../pi/outbox.ts'
import type { ChannelPort } from '../pi/channel.ts'
import { resolveSuperagentConfig, type SuperagentConfig } from './config.ts'
import { PluginExecutor } from './executor.ts'
import { createSuperagentTools, SUPERAGENT_SECTION } from './tools.ts'
import { createWorkerTask, WorkerBridges, type WorkerTaskInput, type WorkerTaskState } from './worker.ts'

/** The plugin: a plain extension (installable in any registry) plus the host-side handles. */
export type SuperagentPlugin = Extension & {
  /** The domain store, for hosts and tests that read ticket state directly. */
  readonly store: Store
  /** Connect the harness the plugin's extension is installed into; required before `start()`. */
  bind(harness: Harness): void
  /** Feed one Trigger through the same path a source uses: intake, gate, eval, dispatch. */
  ingest(trigger: Trigger): void
  /** Start orchestration: effects, restart recovery, passes, and the harness scheduler. */
  start(): Promise<void>
  /** Stop orchestration and close the domain store; the harness itself stays the host's to close. */
  stop(): Promise<void>
}

/** Build the super-agent extension and its host handles from one configuration. */
export function createSuperagentExtension(config: SuperagentConfig): SuperagentPlugin {
  const cfg = resolveSuperagentConfig(config)
  const log = cfg.log
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 })
  const release = lockSync(cfg.stateDir, { stale: 30_000 })
  const store = new Store(join(cfg.stateDir, 'orchestrator.sqlite'), error => log('store', String(error)))
  bootstrapSettings(store, cfg)

  const board = new HealthBoard()
  const effects = new Effects(store, board)
  const channel: ChannelPort = {
    send: message => cfg.channel.send(message),
    scope: input => cfg.scope?.(input) ?? defaultScope(input),
  }
  const outbox = new FeishuOutbox({ store, effects, channel, paused: () => store.settings().paused, log })
  const engineRef: { current?: Engine } = {}
  const assessor = new GlmAssessor(
    { model: cfg.router.model, baseUrl: cfg.assessor.baseUrl, apiKeyEnv: cfg.assessor.apiKeyEnv },
    { decide: (triggerId, outcome) => engineRef.current?.decide(triggerId, outcome), log },
  )
  const bridges = new WorkerBridges()
  const harnessRef: { current?: Harness } = {}
  const executor = new PluginExecutor({
    store, cfg, bridges,
    engine: () => engineRef.current!,
    workerTask: () => workerTask,
    harness: () => harnessRef.current,
  })
  const scope = { scope: (input: { source: string; meta: Record<string, unknown> }) => channel.scope(input) }
  const engine = new Engine({
    repo: store,
    policy: () => settingsPolicy(store.settings(), scope),
    scope,
    assessor,
    executor,
    outbox,
    prepareTicket: ticket => ticket,
    log,
  })
  engineRef.current = engine
  const lifetime = new AbortController()
  let closed = false
  const passes = new Passes({
    engine,
    effects,
    health: board.claim('passes', { state: 'starting', detail: '' }),
    lifetime: lifetime.signal,
    configured: () => !!harnessRef.current,
    closing: () => closed,
  })
  const workerTask = createWorkerTask({ store, cfg, engine: () => engineRef.current!, bridges })
  const extension = defineExtension({
    name: 'superagent',
    tools: createSuperagentTools({ store, cfg, engine: () => engineRef.current!, executor, bridges }),
    sections: [section('superagent', () => SUPERAGENT_SECTION, { tag: true })],
    tasks: [workerTask],
  })

  const plugin: SuperagentPlugin = Object.assign(extension, {
    store,
    bind(harness: Harness): void {
      harnessRef.current = harness
      void executor.drain(BACKGROUND_CONTEXT).catch(error => log('worker launch failed', String(error)))
    },
    ingest(trigger: Trigger): void {
      try {
        const result = passes.receive(trigger)
        log('trigger received', { id: trigger.id, actor: trigger.actor.id, result })
      } catch (error) {
        log('trigger refused', String((error as Error)?.message ?? error))
      }
    },
    async start(): Promise<void> {
      const harness = harnessRef.current
      if (!harness) throw new Error('bind(harness) before start()')
      // Effects only dispatch between start() and drain(); queued receipts wait until then.
      effects.start()
      // Recover before resuming the scheduler, so superseded worker tasks exit instead of racing their successors.
      recover()
      passes.start()
      harness.resume()
      log('superagent plugin ready', {
        state: cfg.stateDir,
        evalMode: store.settings().eval.mode,
        router: `${cfg.router.provider}/${cfg.router.model}`,
        worker: `${cfg.worker.provider}/${cfg.worker.model}`,
        maxWorkers: cfg.maxWorkers,
      })
    },
    async stop(): Promise<void> {
      if (closed) return
      closed = true
      await passes.stop()
      await effects.drain().catch(() => {})
      bridges.stopAll()
      executor.close()
      store.close()
      release()
      log('superagent plugin stopped')
    },
  })

  /** Assignments left `running` by a previous process were interrupted; the domain records it for retry. */
  function recover(): void {
    for (const ticket of store.tickets.active()) {
      const assignment = ticket.assignments.at(-1)
      if (assignment?.state === 'running') {
        engine.assignmentInterrupted(ticket.id, assignment.id)
        log('interrupted assignment recovered', `${ticket.id}/${assignment.id}`)
      } else if (assignment?.state === 'pending' && liveTicket(ticket)) {
        // A pending assignment whose worker task was never committed (a crash mid-dispatch): relaunch it.
        log('pending assignment relaunched', `${ticket.id}/${assignment.id}`)
        executor.start(ticket, assignment)
      }
    }
  }

  return plugin
}

function defaultScope(input: { meta: Record<string, unknown> }): ScopeResult {
  return input.meta.chatType === 'p2p'
    ? { listened: true, observed: false, row: 'direct' }
    : { listened: true, observed: true, row: 'group' }
}

/** Seed the first settings revision from the config, then backfill trusted sources idempotently. */
function bootstrapSettings(store: Store, cfg: ReturnType<typeof resolveSuperagentConfig>): void {
  const trustedEntries = (): Record<string, { allowed: []; allowAll: true; admission: {} }> =>
    Object.fromEntries(cfg.trustedSources.map(source => [source, { allowed: [], allowAll: true, admission: {} }]))
  const seeded = store.settingsHistory(1).length > 0
  const current = store.settings()
  if (!seeded) {
    store.saveSettings({
      ...current,
      eval: { ...current.eval, mode: cfg.evalMode },
      executor: { ...current.executor, maxWorkers: cfg.maxWorkers },
      policy: {
        ...current.policy,
        sources: {
          ...current.policy.sources,
          [cfg.source]: {
            ...(current.policy.sources[cfg.source] ?? {}),
            allowed: cfg.allowedActors.map(id => ({ id })),
            allowAll: cfg.allowAll,
            admission: { group: { listedUnaddressed: cfg.unaddressedAdmission } },
          },
          ...trustedEntries(),
        },
      },
    })
    return
  }
  // Old stores predating trustedSources: add any missing entries without touching the existing ones.
  const missing = cfg.trustedSources.filter(source => !current.policy.sources[source])
  if (!missing.length) return
  store.saveSettings({
    ...current,
    policy: { ...current.policy, sources: { ...current.policy.sources, ...Object.fromEntries(missing.map(source => [source, { allowed: [], allowAll: true, admission: {} }])) } },
  })
  cfg.log('settings backfilled trusted sources', missing)
}

export { SUPERAGENT_TOOLS } from './tools.ts'
export type { SuperagentConfig, SuperagentChannel, EvalMode } from './config.ts'
export type { WorkerTaskInput } from './worker.ts'
export { runningAssignments } from './worker.ts'
export default createSuperagentExtension
