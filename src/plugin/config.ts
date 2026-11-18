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
}

export interface ResolvedSuperagentConfig extends Required<Omit<SuperagentConfig, 'scope' | 'log' | 'channel' | 'router' | 'worker' | 'assessor'>> {
  router: { provider: string; model: string }
  worker: { provider: string; model: string }
  assessor: { baseUrl: string; apiKeyEnv: string }
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
    unaddressedAdmission: config.unaddressedAdmission ?? 'ignore',
    assessor: {
      baseUrl: config.assessor?.baseUrl ?? DEFAULT_ASSESSOR_BASE,
      apiKeyEnv: config.assessor?.apiKeyEnv ?? 'ZHIPU_API_KEY',
    },
    workerTurnTimeoutMs: config.workerTurnTimeoutMs ?? Number(process.env.SUP_TURN_TIMEOUT_MS || 30 * 60_000),
    replyLanguage: config.replyLanguage ?? '',
    scope: config.scope,
    log,
  }
}
