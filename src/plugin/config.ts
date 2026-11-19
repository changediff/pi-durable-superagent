/**
 * Configuration of the super-agent plugin (`createSuperagentExtension`).
 *
 * The plugin carries only what the domain needs: where state lives, which models the Router and
 * Worker run on, how many workers may run at once, and how to deliver outbound messages. The host
 * owns everything transport-specific — the channel callback receives delivery, it never imports Feishu.
 */
import type { OutboundMessage, ScopeResult } from '../core/index.ts'

export type EvalMode = 'off' | 'observe' | 'auto'

/** Outbound delivery the host supplies: Feishu replies in production, a recorder in tests. */
export interface SuperagentChannel {
  send(message: OutboundMessage): Promise<'sent' | 'gone' | 'waiting'>
}

export interface A2APeerConfig {
  name: string
  url: string
  token?: string
  timeout?: number
}

/** Agent-to-agent settings owned by the plugin: inbound semantics plus the outbound peer table. */
export interface SuperagentA2AConfig {
  /** Run the inbound A2A JSON-RPC surface; default false. */
  enabled?: boolean
  /** Listen port of the inbound server; default 18802. */
  port?: number
  /** Bearer token inbound callers must present; empty accepts unauthenticated calls. */
  token?: string
  /** URL published in the agent card. */
  publicUrl?: string
  /** How long an inbound SendMessage waits for the final reply; default 100000ms. */
  waitMs?: number
  /** Named peer agents the `a2a_send` tool may call. */
  peers?: A2APeerConfig[]
}

/** The a2a section after defaults are applied. */
export interface ResolvedSuperagentA2AConfig {
  enabled: boolean
  port: number
  token: string
  publicUrl: string
  waitMs: number
  peers: A2APeerConfig[]
}

export interface SuperagentConfig {
  /** Directory of the SQLite domain store (`orchestrator.sqlite`); the plugin locks it exclusively. */
  stateDir: string
  /** Root for per-ticket worker directories (`<workDir>/superagent/<ticket id>`). */
  workDir: string
  /** pi-durable storage directory the host opens its Harness on (worker transcripts live there). */
  harnessDir: string
  /** Maximum concurrently running worker conversations. */
  maxWorkers: number
  /** `auto` accepts requests; `observe` records would-accepts; `off` ignores candidates. */
  evalMode: EvalMode
  /** Router (assessor) model identity. */
  router: { provider: string; model: string }
  /** Worker model identity used for worker conversations. */
  worker: { provider: string; model: string }
  /** Delivery of acknowledgements, results and notices; supplied by the host. */
  channel: SuperagentChannel
  /** Whether a source listens to a trigger; default: everything, observed, as a direct row. */
  scope?(input: { source: string; meta: Record<string, unknown> }): ScopeResult
  /** Source name triggers are recorded under (also keys the settings policy); default `feishu`. */
  source?: string
  /** Every human sender may originate work; default true (the dispatch surface is the authority). */
  allowAll?: boolean
  /** Explicitly allowed actor ids when `allowAll` is false. */
  allowedActors?: string[]
  /** Sources whose senders are trusted wholesale (allowAll) in the settings policy, e.g. `a2a`. */
  trustedSources?: string[]
  /** Admission for listed senders that do not address the agent; default `ignore`. */
  unaddressedAdmission?: 'ignore' | 'inferred'
  /** GLM endpoint the Router assessor calls; default the Zhipu coding endpoint. */
  assessor?: { baseUrl?: string; apiKeyEnv?: string }
  /** Per-turn worker timeout in milliseconds; default 30 minutes. */
  workerTurnTimeoutMs?: number
  /** Reply language hint passed to workers ("" keeps the user's language). */
  replyLanguage?: string
  /** Structured log; default `console.log` prefixed `[superagent]`. */
  log?(message: string, detail?: unknown): void
  /** Agent-to-agent settings: inbound server behavior and the outbound peer table. */
  a2a?: SuperagentA2AConfig
}

export interface ResolvedSuperagentConfig extends Required<Omit<SuperagentConfig, 'scope' | 'log' | 'channel' | 'router' | 'worker' | 'assessor' | 'a2a'>> {
  router: { provider: string; model: string }
  worker: { provider: string; model: string }
  assessor: { baseUrl: string; apiKeyEnv: string }
  /** Agent-to-agent settings after defaults are applied. */
  a2a: ResolvedSuperagentA2AConfig
  channel: SuperagentChannel
  scope?(input: { source: string; meta: Record<string, unknown> }): ScopeResult
  log(message: string, detail?: unknown): void
}

const DEFAULT_STATE_DIR = '/workspace/.superagent'
const DEFAULT_WORK_DIR = '/work'
const DEFAULT_ASSESSOR_BASE = 'https://open.bigmodel.cn/api/coding/paas/v4'

/** Fill a plugin config with the defaults every optional field documents. */
export function resolveSuperagentConfig(config: SuperagentConfig): ResolvedSuperagentConfig {
  const log = config.log ?? ((message: string, detail?: unknown) => {
    if (detail === undefined) console.log(`[superagent] ${message}`)
    else console.log(`[superagent] ${message}`, typeof detail === 'string' ? detail : JSON.stringify(detail))
  })
  return {
    stateDir: config.stateDir || DEFAULT_STATE_DIR,
    workDir: config.workDir || DEFAULT_WORK_DIR,
    harnessDir: config.harnessDir || `${config.stateDir || DEFAULT_STATE_DIR}/harness`,
    maxWorkers: config.maxWorkers,
    evalMode: config.evalMode,
    router: config.router,
    worker: config.worker,
    channel: config.channel,
    source: config.source ?? 'feishu',
    allowAll: config.allowAll ?? true,
    allowedActors: config.allowedActors ?? [],
    trustedSources: config.trustedSources ?? [],
    unaddressedAdmission: config.unaddressedAdmission ?? 'ignore',
    assessor: {
      baseUrl: config.assessor?.baseUrl ?? DEFAULT_ASSESSOR_BASE,
      apiKeyEnv: config.assessor?.apiKeyEnv ?? 'ZHIPU_API_KEY',
    },
    workerTurnTimeoutMs: config.workerTurnTimeoutMs ?? Number(process.env.SUP_TURN_TIMEOUT_MS || 30 * 60_000),
    replyLanguage: config.replyLanguage ?? '',
    scope: config.scope,
    log,
    a2a: {
      enabled: config.a2a?.enabled ?? false,
      port: config.a2a?.port ?? 18802,
      token: config.a2a?.token ?? '',
      publicUrl: config.a2a?.publicUrl ?? `http://127.0.0.1:${config.a2a?.port ?? 18802}`,
      waitMs: config.a2a?.waitMs ?? 100_000,
      peers: config.a2a?.peers ?? [],
    },
  }
}
