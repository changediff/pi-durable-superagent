/** Environment-driven configuration for the pi-durable super-agent port. */
import { z } from 'zod'
import { OPENVIKING_DEFAULT_ENDPOINT, OPENVIKING_DEFAULT_PEER } from '../plugin/openviking.ts'
import { PEER_COW_URL, PEER_HERMES_URL, PEER_DEFAULT_TIMEOUT_MS, PEER_MAX_TIMEOUT_MS } from '../plugin/peers.ts'

const csv = (value: string | undefined): string[] =>
  (value ?? '').split(',').map(item => item.trim()).filter(Boolean)

const truthy = (value: string | undefined): boolean => /^(1|true|yes|on)$/i.test(value ?? '')

export const ConfigSchema = z.object({
  /** Where the SQLite domain store, harness JSONL sessions and worker directories live. */
  stateDir: z.string().min(1),
  /** Default cwd for worker conversations. */
  workDir: z.string().min(1),
  /** pi-durable JSONL storage directory (crash-resume checkpoints). */
  harnessDir: z.string().min(1),

  provider: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().min(1).default('ZHIPU_API_KEY'),
  contextWindow: z.number().int().positive(),
  maxTokens: z.number().int().positive(),

  workerProvider: z.string().min(1),
  workerModel: z.string().min(1),
  maxWorkers: z.number().int().min(1).max(16),

  /** Turn watchdog: mode, pacing, model id (provider follows the worker's) and nudge budget. */
  watchdog: z.object({
    mode: z.enum(['off', 'observe', 'auto']),
    intervalMs: z.number().int().positive(),
    model: z.string().min(1),
    maxInterventions: z.number().int().min(1),
  }),

  /** `auto` accepts explicit requests; `observe` records them as would-accept; `off` ignores candidates. */
  evalMode: z.enum(['off', 'observe', 'auto']),
  /** Admission strength for messages from listed senders that do not address the bot. */
  unaddressedAdmission: z.enum(['ignore', 'inferred']),

  /** Feishu bot credentials (required by the server; `--selftest` uses a memory channel). */
  feishuAppId: z.string().default(''),
  feishuAppSecret: z.string().default(''),
  feishuDomain: z.enum(['feishu', 'lark']),
  /** Every human sender is allowed when true; otherwise only `allowedOpenIds` may originate work. */
  allowAll: z.boolean(),
  allowedOpenIds: z.array(z.string()),
  /** Receive every group message (true) or only mentions and direct messages (false). */
  listenAllChats: z.boolean(),
  /** Reply language hint passed to the worker ("", "zh", "en"). */
  replyLanguage: z.string().default(''),

  /**
   * BYOM device daemon surface (`POST /daemon/*`), mounted on the A2A listener. Enabled by
   * `SUP_DAEMON=on`; every request must carry `Authorization: Bearer $SUP_DAEMON_TOKEN`.
   */
  daemon: z.object({
    enabled: z.boolean(),
    token: z.string(),
  }),

  /**
   * OpenViking memory database (`viking_*` tools, design doc §014). Off unless `SUP_OPENVIKING=on`;
   * the key comes from `SUP_OPENVIKING_API_KEY` with `OPENVIKING_API_KEY` as fallback and is sent
   * in headers only.
   */
  openviking: z.object({
    enabled: z.boolean(),
    endpoint: z.string().url(),
    apiKey: z.string(),
    /** Writes are isolated into this peer's space (`X-OpenViking-Actor-Peer`). */
    peer: z.string(),
    /** Tenant headers, retried only when the server answers 401. */
    account: z.string(),
    user: z.string(),
  }),

  /**
   * Outbound peer agents (`peer_*` tools, design doc §014 cut 2). Off unless `SUP_PEERS=on`;
   * the two peers are builtin, so this section may only override their URLs, tokens and the
   * shared timeout — never add an unknown peer. Tokens come from the environment, headers only.
   */
  peers: z.object({
    enabled: z.boolean(),
    hermesUrl: z.string().url(),
    hermesToken: z.string(),
    cowUrl: z.string().url(),
    cowToken: z.string(),
    timeoutMs: z.number().int().positive().max(PEER_MAX_TIMEOUT_MS),
  }),

  /** A2A (agent-to-agent) section passed whole to the plugin; disabled unless `SUP_A2A` is set. */
  a2a: z.object({
    enabled: z.boolean(),
    port: z.number().int().min(1).max(65535),
    token: z.string(),
    /** AgentCard 里对外公布的地址 */
    publicUrl: z.string(),
    waitMs: z.number().int().positive(),
    peers: z.array(z.object({
      name: z.string(),
      url: z.string(),
      token: z.string().default(''),
      timeout: z.number().int().positive().default(100),
    })),
  }),
})

export type Config = z.infer<typeof ConfigSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const stateDir = env.SUP_STATE_DIR || '/workspace/.superagent'
  return ConfigSchema.parse({
    stateDir,
    workDir: env.SUP_WORK_DIR || env.FEISHU_PI_CWD || '/work',
    harnessDir: env.SUP_HARNESS_DIR || `${stateDir}/harness`,
    provider: env.SUP_PROVIDER || 'zhipu',
    model: env.SUP_MODEL || 'glm-5.3',
    baseUrl: env.SUP_API_BASE || 'https://open.bigmodel.cn/api/coding/paas/v4',
    apiKeyEnv: env.SUP_API_KEY_ENV || 'ZHIPU_API_KEY',
    contextWindow: Number(env.SUP_CONTEXT_WINDOW || 200_000),
    maxTokens: Number(env.SUP_MAX_TOKENS || 32_768),
    workerProvider: env.SUP_WORKER_PROVIDER || env.SUP_PROVIDER || 'zhipu',
    workerModel: env.SUP_WORKER_MODEL || env.SUP_MODEL || 'glm-5.3',
    maxWorkers: Number(env.SUP_MAX_WORKERS || 3),
    watchdog: {
      mode: watchdogMode(env.SUP_WATCHDOG),
      intervalMs: Number(env.SUP_WATCHDOG_INTERVAL_MS || 120_000),
      // An unset watchdog model keeps the worker's; the provider always follows the worker's.
      model: env.SUP_WATCHDOG_MODEL || env.SUP_WORKER_MODEL || env.SUP_MODEL || 'glm-5.3',
      maxInterventions: Number(env.SUP_WATCHDOG_MAX_INTERVENTIONS || 2),
    },
    evalMode: (env.SUP_EVAL_MODE as Config['evalMode']) || 'auto',
    unaddressedAdmission: env.SUP_UNADDRESSED === 'inferred' ? 'inferred' : 'ignore',
    feishuAppId: env.FEISHU_APP_ID || '',
    feishuAppSecret: env.FEISHU_APP_SECRET || '',
    feishuDomain: env.FEISHU_DOMAIN === 'lark' ? 'lark' : 'feishu',
    allowAll: truthy(env.SUP_ALLOW_ALL),
    allowedOpenIds: csv(env.SUP_ALLOWED_OPEN_IDS || env.FEISHU_ALLOWED_OPEN_IDS),
    listenAllChats: truthy(env.SUP_LISTEN_ALL_CHATS),
    replyLanguage: env.SUP_REPLY_LANGUAGE || '',
    daemon: {
      enabled: truthy(env.SUP_DAEMON),
      // Empty token rejects every daemon request: the surface is never open without a bearer.
      token: env.SUP_DAEMON_TOKEN || '',
    },
    openviking: {
      enabled: truthy(env.SUP_OPENVIKING),
      endpoint: env.SUP_OPENVIKING_ENDPOINT || OPENVIKING_DEFAULT_ENDPOINT,
      apiKey: env.SUP_OPENVIKING_API_KEY || env.OPENVIKING_API_KEY || '',
      peer: env.SUP_OPENVIKING_PEER || OPENVIKING_DEFAULT_PEER,
      account: env.SUP_OPENVIKING_ACCOUNT || 'default',
      user: env.SUP_OPENVIKING_USER || 'default',
    },
    peers: {
      enabled: truthy(env.SUP_PEERS),
      hermesUrl: env.SUP_PEER_HERMES_URL || PEER_HERMES_URL,
      hermesToken: env.SUP_PEER_HERMES_TOKEN || '',
      cowUrl: env.SUP_PEER_COW_URL || PEER_COW_URL,
      cowToken: env.SUP_PEER_COW_TOKEN || '',
      // The configured budget is capped like the caller-facing timeoutSec: 900s at most.
      timeoutMs: Math.min(Number(env.SUP_PEER_TIMEOUT_MS || PEER_DEFAULT_TIMEOUT_MS), PEER_MAX_TIMEOUT_MS),
    },
    a2a: {
      enabled: truthy(env.SUP_A2A),
      port: Number(env.SUP_A2A_PORT || 18802),
      token: env.SUP_A2A_TOKEN || '',
      publicUrl: env.SUP_A2A_PUBLIC_URL || `http://cc2.pig-bowfin.ts.net:${Number(env.SUP_A2A_PORT || 18802)}`,
      waitMs: Number(env.SUP_A2A_WAIT_MS || 100000),
      peers: parsePeers(env.SUP_A2A_PEERS),
    },
  })
}

/** `SUP_WATCHDOG` value to mode; unset and unrecognised values keep the watchdog off. */
function watchdogMode(value: string | undefined): Config['watchdog']['mode'] {
  return value === 'observe' || value === 'auto' ? value : 'off'
}

/** `SUP_A2A_PEERS` JSON array; a parse failure yields no peers instead of failing startup. */
function parsePeers(value: string | undefined): Config['a2a']['peers'] {
  if (!value) return []
  try {
    const parsed: unknown = JSON.parse(value)
    const result = z.array(z.object({
      name: z.string(),
      url: z.string(),
      token: z.string().default(''),
      timeout: z.number().int().positive().default(100),
    })).parse(parsed)
    return result
  } catch {
    return []
  }
}
