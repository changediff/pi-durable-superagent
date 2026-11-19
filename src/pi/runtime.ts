/**
 * Thin host of the pi-durable super-agent port.
 *
 * The domain (Engine, Store, Effects, Passes, outbox, assessor, durable workers) now lives in the
 * `superagent` plugin (`src/plugin`), installable into any pi-durable Harness. What is left here
 * is host wiring: build the registry (CodingTools + the plugin), open one harness on the JSONL
 * storage with the GLM models and the Node environment, keep the Feishu WebSocket source for
 * inbound triggers and delivery, and feed triggers into the plugin. Everything the panel used to
 * show is in `docker logs` and the SQLite file.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Harness, createRegistry, type ConversationId } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node'
import type { Trigger } from '../core/index.ts'
import type { OutboundMessage } from '../core/index.ts'
import type { ScopeResult } from '../core/index.ts'
import { HealthBoard } from '../infra/health.ts'
import { createSuperagentExtension, type SuperagentPlugin } from '../plugin/index.ts'
import { createReactExtension, type ReactExtension } from '../plugin/react.ts'
import type { Config } from './config.ts'
import { FeishuSource } from './feishu.ts'
import type { ChannelPort } from './channel.ts'
import { A2AChannel } from './a2a.ts'
import { DaemonHttpApi } from '../daemon/http.ts'
import { daemonBroker } from '../daemon/service.ts'
import { buildModels } from './models.ts'

export interface RuntimeOptions {
  log?: (message: string, detail?: unknown) => void
  /** Injected for `--selftest`; defaults to the Feishu WebSocket source. */
  channel?: ChannelPort
}

/** Fan out one logical channel over the primary source and the optional A2A server. */
class CompositeChannel implements ChannelPort {
  constructor(private readonly primary: ChannelPort, private readonly a2a?: ChannelPort) {}

  async start(): Promise<void> {
    await this.primary.start?.()
    await this.a2a?.start?.()
  }

  async stop(): Promise<void> {
    await this.primary.stop?.()
    await this.a2a?.stop?.()
  }

  async send(message: OutboundMessage): Promise<'sent' | 'gone' | 'waiting'> {
    if (message.channel.source === 'a2a') {
      if (!this.a2a) return 'gone'
      return this.a2a.send(message)
    }
    return this.primary.send(message)
  }

  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult {
    if (input.source === 'a2a') {
      if (!this.a2a) return { listened: false, reason: 'a2a disabled' }
      return this.a2a.scope(input)
    }
    return this.primary.scope(input)
  }
}

export class PiSuperagentRuntime {
  readonly plugin: SuperagentPlugin
  readonly channel: ChannelPort
  /** The async ReAct tools (start/stop/list), at the CodingTools layer so every session gets them. */
  readonly react: ReactExtension
  readonly registry = createRegistry()
  /** The listener shared by A2A and `/daemon/*`; present when either surface is on. */
  private readonly http?: A2AChannel
  /** Whether the A2A channel already owns `http`'s lifecycle through `CompositeChannel`. */
  private readonly a2aMounted: boolean
  private harness?: Harness
  private readonly board = new HealthBoard()
  private closed = false

  constructor(readonly cfg: Config, private readonly options: RuntimeOptions = {}) {
    const log = this.log.bind(this)
    this.plugin = createSuperagentExtension({
      stateDir: cfg.stateDir,
      workDir: cfg.workDir,
      harnessDir: cfg.harnessDir,
      maxWorkers: cfg.maxWorkers,
      evalMode: cfg.evalMode,
      router: { provider: cfg.provider, model: cfg.model },
      worker: { provider: cfg.workerProvider, model: cfg.workerModel },
      watchdog: {
        mode: cfg.watchdog.mode,
        intervalMs: cfg.watchdog.intervalMs,
        maxInterventions: cfg.watchdog.maxInterventions,
        model: { provider: cfg.workerProvider, model: cfg.watchdog.model },
      },
      channel: { send: message => this.channel.send(message) },
      scope: input => this.channel.scope(input),
      allowAll: cfg.allowAll,
      allowedActors: cfg.allowedOpenIds,
      trustedSources: cfg.a2a.enabled ? ['a2a'] : [],
      unaddressedAdmission: cfg.unaddressedAdmission,
      assessor: { baseUrl: cfg.baseUrl, apiKeyEnv: cfg.apiKeyEnv },
      replyLanguage: cfg.replyLanguage,
      a2a: cfg.a2a,
      log,
    })
    const primary = this.options.channel ?? new FeishuSource(cfg, { onTrigger: trigger => this.plugin.ingest(trigger), log })
    // One listener serves both surfaces: A2A JSON-RPC at its own paths, the device daemon at
    // `/daemon/*` with a separate bearer token. That keeps the container's published port and the
    // server lifecycle single, whether A2A is enabled, the daemon is, or both.
    const daemonApi = cfg.daemon.enabled
      ? new DaemonHttpApi({ registry: daemonBroker().registry, token: cfg.daemon.token, log })
      : undefined
    const http = cfg.a2a.enabled || cfg.daemon.enabled
      ? new A2AChannel(cfg.a2a, { onTrigger: trigger => this.plugin.ingest(trigger), log }, daemonApi, cfg.a2a.enabled)
      : undefined
    this.http = http
    this.a2aMounted = cfg.a2a.enabled && http !== undefined
    this.channel = this.a2aMounted && http ? new CompositeChannel(primary, http) : primary
    this.react = createReactExtension({
      // Delivery resolves the harness lazily: the registry is built before the harness opens.
      session: async id => this.harness?.conversation(Number(id) as ConversationId, BACKGROUND_CONTEXT),
      // A result delivered after its ticket ended goes back into the domain as an event for Eval.
      ticketOf: id => this.plugin.ticketOfConversation(String(id)),
      onResult: input => this.plugin.reactResult(input),
      log,
    })
    this.registry.install(CodingTools)
    this.registry.install(this.react)
    this.registry.install(this.plugin)
  }

  /** The domain store (tickets, threads, decisions, outbox receipts), owned by the plugin. */
  get store(): SuperagentPlugin['store'] { return this.plugin.store }

  async start(): Promise<void> {
    const { cfg } = this
    await mkdir(cfg.harnessDir, { recursive: true })
    const storage = await openNodeJsonlStorage(cfg.harnessDir, BACKGROUND_CONTEXT, { fsync: true })
    this.harness = await Harness.open(storage, {
      models: buildModels(cfg),
      registry: this.registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd || cfg.workDir }),
    }, BACKGROUND_CONTEXT)
    this.plugin.bind(this.harness)
    await this.plugin.start()
    // Long connections are the only inbound path; a failed start must fail the process, not idle silently.
    await this.channel.start?.()
    if (this.http && !this.a2aMounted) await this.http.start()
    if (cfg.a2a.enabled) this.log('a2a ready', { url: cfg.a2a.publicUrl })
    if (cfg.daemon.enabled) {
      this.log('daemon routes ready', { port: cfg.a2a.port, auth: cfg.daemon.token ? 'bearer' : 'rejecting (no token)' })
    }
    this.board.claim('runtime', { state: 'ready', detail: 'super-agent ready', at: new Date().toISOString() })
    this.log('runtime ready', {
      state: cfg.stateDir,
      evalMode: this.plugin.store.settings().eval.mode,
      model: `${cfg.provider}/${cfg.model}`,
      worker: `${cfg.workerProvider}/${cfg.workerModel}`,
    })
  }

  /** Feed one Trigger through the same path the Feishu WebSocket uses (selftest and local dispatch). */
  inject(trigger: Trigger): void {
    this.plugin.ingest(trigger)
  }

  async stop(): Promise<void> {
    if (this.closed) return
    this.closed = true
    // Every session ends with the process: kill the background tasks they left running.
    this.react.jobs.disposeAll()
    await this.plugin.stop()
    await this.harness?.close(BACKGROUND_CONTEXT).catch(() => {})
    await this.channel.stop?.()
    if (this.http && !this.a2aMounted) await this.http.stop()
    this.log('runtime stopped')
  }

  private log(message: string, detail?: unknown): void {
    if (this.options.log) this.options.log(message, detail)
    else if (detail === undefined) console.log(`[superagent] ${message}`)
    else console.log(`[superagent] ${message}`, typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
}
