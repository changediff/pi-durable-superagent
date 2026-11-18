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
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node'
import type { Trigger } from '../core/index.ts'
import { HealthBoard } from '../infra/health.ts'
import { createSuperagentExtension, type SuperagentPlugin } from '../plugin/index.ts'
import type { Config } from './config.ts'
import { FeishuSource } from './feishu.ts'
import type { ChannelPort } from './channel.ts'
import { buildModels } from './models.ts'

export interface RuntimeOptions {
  log?: (message: string, detail?: unknown) => void
  /** Injected for `--selftest`; defaults to the Feishu WebSocket source. */
  channel?: ChannelPort
}

export class PiSuperagentRuntime {
  readonly plugin: SuperagentPlugin
  readonly channel: ChannelPort
  readonly registry = createRegistry()
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
      channel: { send: message => this.channel.send(message) },
      scope: input => this.channel.scope(input),
      allowAll: cfg.allowAll,
      allowedActors: cfg.allowedOpenIds,
      unaddressedAdmission: cfg.unaddressedAdmission,
      assessor: { baseUrl: cfg.baseUrl, apiKeyEnv: cfg.apiKeyEnv },
      replyLanguage: cfg.replyLanguage,
      log,
    })
    this.channel = this.options.channel ?? new FeishuSource(cfg, { onTrigger: trigger => this.plugin.ingest(trigger), log })
    this.registry.install(CodingTools)
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
    await this.plugin.stop()
    await this.harness?.close(BACKGROUND_CONTEXT).catch(() => {})
    await this.channel.stop?.()
    this.log('runtime stopped')
  }

  private log(message: string, detail?: unknown): void {
    if (this.options.log) this.options.log(message, detail)
    else if (detail === undefined) console.log(`[superagent] ${message}`)
    else console.log(`[superagent] ${message}`, typeof detail === 'string' ? detail : JSON.stringify(detail))
  }
}
