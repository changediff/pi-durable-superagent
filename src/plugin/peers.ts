/**
 * The peers plugin (design doc §014, cut 2): the worker's outbound A2A surface to the two known
 * peer agents, `hermes-cc2` (protocol `hermes`) and `cowagent-deb02` (protocol `a2a`).
 *
 * Two tools: `peer_list` (agent-card probes behind a 10-minute cache — one peer offline never
 * fails the whole listing) and `peer_send` (JSON-RPC `SendMessage` / `message/send`, polling
 * `tasks/get` while the peer answers `TASK_STATE_WORKING`, under one budget that defaults to
 * 300s and caps at 900s — a timeout keeps the `taskId` and says the task is still running).
 * The peer table is builtin: configuration may override a peer's URL and token, never add one.
 * Every failure comes back as error text so the worker picks another peer instead of crashing;
 * transport failures are retried at most once and logged once per peer; the bearer token never
 * reaches a URL, a log line, or an error message. The plugin owns no timers — `stop()` only
 * resets the caches and the log dedupe.
 */
import { randomUUID } from 'node:crypto'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { Extension } from '@earendil-works/pi-durable'
import { int, obj, opt, str } from '@earendil-works/pi-schema'

export const PEERS_TOOLS = ['peer_list', 'peer_send'] as const

/** Builtin peer endpoints; `SUP_PEER_HERMES_URL` / `SUP_PEER_COW_URL` may override them. */
export const PEER_HERMES_URL = 'http://cc2.pig-bowfin.ts.net:18801/'
export const PEER_COW_URL = 'http://deb02.pig-bowfin.ts.net:18789/a2a/v1'
export const PEER_HERMES_TOKEN_ENV = 'SUP_PEER_HERMES_TOKEN'
export const PEER_COW_TOKEN_ENV = 'SUP_PEER_COW_TOKEN'

/** `peer_send` budgets: the default whole-call wait and the hard cap (`timeoutSec` is clamped). */
export const PEER_DEFAULT_TIMEOUT_MS = 300_000
export const PEER_MAX_TIMEOUT_MS = 900_000
/** Agent-card probe budget (the online check must be quick) and the card cache lifetime. */
export const PEER_PROBE_TIMEOUT_MS = 3_000
export const PEER_CARD_CACHE_MS = 10 * 60_000
/** `tasks/get` interval while the peer reports `TASK_STATE_WORKING`. */
export const PEER_POLL_MS = 3_000

export type PeerProtocol = 'hermes' | 'a2a'

/** One builtin peer: identity and wire protocol are fixed, URL and token come from config. */
export interface PeerDefinition {
  readonly id: string
  readonly protocol: PeerProtocol
  readonly url: string
  readonly token: string
  readonly skills: readonly string[]
  /** The env var the token comes from, named in error text (the value never appears). */
  readonly tokenEnv: string
}

/** Live view of one peer: what `peer_list` reports and `peer_send` fails against. */
interface PeerStatus {
  /** `Date.now()` of the last probe; never fresh enough before the first one. */
  probedAt: number
  online: boolean
  name?: string
  lastError?: string
  /** Failures log once per peer until the next success (a restart resets it via `stop()`). */
  failureLogged: boolean
}

export interface PeersConfig {
  /** `hermes-cc2` A2A endpoint; defaults to the builtin cc2 URL. */
  hermesUrl?: string
  /** Bearer token for `hermes-cc2` (`SUP_PEER_HERMES_TOKEN`); empty makes sends fail fast. */
  hermesToken?: string
  /** `cowagent-deb02` A2A endpoint; defaults to the builtin deb02 URL. */
  cowUrl?: string
  /** Bearer token for `cowagent-deb02` (`SUP_PEER_COW_TOKEN`). */
  cowToken?: string
  /** Default `peer_send` budget; 300s, capped at 900s whatever the caller asks. */
  timeoutMs?: number
  /** `tasks/get` poll interval while a peer reports `TASK_STATE_WORKING`. */
  pollMs?: number
  /** Agent-card probe cache lifetime; default 10 minutes. */
  cardCacheMs?: number
  /** Agent-card probe budget; default 3s. */
  probeTimeoutMs?: number
  /** Structured log; the token is never logged. */
  log?(message: string, detail?: unknown): void
  /** Injectable fetch (tests); defaults to the global one. */
  fetch?: typeof globalThis.fetch
}

export interface PeerListArgs { }

export interface PeerSendArgs {
  peer: string
  text: string
  contextId?: string
  timeoutSec?: number
}

/** What `peer_send` resolves with: one JSON body whatever the peer did. */
export interface PeerSendOutcome {
  peer: string
  state: string
  text: string
  taskId: string
  elapsedMs: number
}

export type PeersExtension = Extension & {
  /** Nothing to tear down (no timers); resets the card cache and the once-per-peer failure log. */
  readonly stop: () => void
}

/** A request failure already formatted for logs and error text; `transport` marks network errors. */
class PeerCallError extends Error {
  constructor(message: string, readonly transport: boolean) {
    super(message)
  }
}

/** Task states we keep polling; everything else (`completed`, `failed`, …) settles the call. */
const PENDING_STATES = new Set(['working', 'submitted'])

const snippet = (text: string): string => {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed ? `：${trimmed.slice(0, 160)}` : ''
}

/** The peer's agent-card URL: the well-known path on the URL's origin (hermes serves it at the root, cow next to `/a2a/v1`). */
export function agentCardUrl(peerUrl: string): string {
  return `${new URL(peerUrl).origin}/.well-known/agent-card.json`
}

/** One JSON request under an abort budget; throws `PeerCallError` with the transport flag set for network failures. */
async function requestJson(
  url: string,
  spec: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number; token: string; fetch: typeof globalThis.fetch },
): Promise<unknown> {
  const payload = spec.body === undefined ? undefined : JSON.stringify(spec.body)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs)
  timer.unref?.()
  let response: Response
  try {
    response = await spec.fetch(url, {
      method: spec.method,
      headers: {
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        ...(spec.token ? { authorization: `Bearer ${spec.token}` } : {}),
      },
      body: payload,
      signal: controller.signal,
    })
  } catch (error) {
    const aborted = (error as { name?: string } | undefined)?.name === 'AbortError'
    const cause = (error as { cause?: { message?: string } } | undefined)?.cause
    const reason = aborted ? `请求超时（${Math.round(spec.timeoutMs / 1000)}s）` : String(cause?.message ?? (error as Error | undefined)?.message ?? error)
    throw new PeerCallError(reason, true)
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new PeerCallError(`HTTP ${response.status}${snippet(detail)}`, false)
  }
  const text = await response.text()
  try {
    return text ? (JSON.parse(text) as unknown) : undefined
  } catch {
    throw new PeerCallError(`非 JSON 响应（HTTP ${response.status}）${snippet(text)}`, false)
  }
}

/** Run one request; a transport failure gets exactly one retry, everything else fails at once. */
async function withOneRetry(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation()
  } catch (error) {
    if (!(error instanceof PeerCallError) || !error.transport) throw error
    return await operation()
  }
}

/** Loose record access helpers over the peer's JSON-RPC answers. */
const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

/** `result.task` when the peer wraps it (this server's shape), else `result` itself (bare task). */
function taskOf(payload: unknown): Record<string, unknown> {
  const result = asRecord(payload).result
  if (Array.isArray(result) || result === null || typeof result !== 'object') return asRecord(result)
  return asRecord(asRecord(result).task ?? result)
}

/** `TASK_STATE_WORKING` → `working`; anything unprefixed passes through lowercased. */
function taskState(task: Record<string, unknown>): string {
  const raw = String(asRecord(task.status).state ?? '')
  return (raw.startsWith('TASK_STATE_') ? raw.slice('TASK_STATE_'.length) : raw).toLowerCase()
}

/** Concatenate the `text` fields of a parts array (v1.0 `kind` and legacy shapes alike). */
function textOfParts(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  return parts.map(part => String((part as { text?: unknown })?.text ?? '')).filter(Boolean).join('\n')
}

/**
 * The reply text of a task: hermes answers in `status.message.parts[0].text`, so its protocol
 * reads the status message only; the a2a (cow) protocol falls back to `artifacts[].parts[].text`
 * when the status message carries no text.
 */
function textOfTask(task: Record<string, unknown>, protocol: PeerProtocol): string {
  const statusText = textOfParts(asRecord(asRecord(task.status).message).parts)
  if (protocol === 'hermes') return statusText
  const artifacts = Array.isArray(task.artifacts)
    ? (task.artifacts as unknown[]).flatMap(artifact => textOfParts(asRecord(artifact).parts))
    : []
  return statusText || artifacts.filter(Boolean).join('\n')
}

/** A tool failure as plain error text: the worker keeps its turn and may pick another peer. */
const failure = (tool: string, message: string): { isError: true; output: [{ type: 'text'; text: string }] } => ({
  isError: true,
  output: [{ type: 'text', text: `${tool}: ${message}` }],
})

/** Build the peers extension from its configuration. */
export function createPeersExtension(config: PeersConfig = {}): PeersExtension {
  const log = config.log ?? (() => {})
  const fetch = config.fetch ?? ((input, init) => globalThis.fetch(input, init))
  const timeoutMs = Math.min(config.timeoutMs ?? PEER_DEFAULT_TIMEOUT_MS, PEER_MAX_TIMEOUT_MS)
  const pollMs = config.pollMs ?? PEER_POLL_MS
  const cardCacheMs = config.cardCacheMs ?? PEER_CARD_CACHE_MS
  const probeTimeoutMs = config.probeTimeoutMs ?? PEER_PROBE_TIMEOUT_MS
  const peers: readonly PeerDefinition[] = [
    { id: 'hermes-cc2', protocol: 'hermes', url: config.hermesUrl ?? PEER_HERMES_URL, token: config.hermesToken ?? '', skills: ['coding', 'ops', 'memory', 'research'], tokenEnv: PEER_HERMES_TOKEN_ENV },
    { id: 'cowagent-deb02', protocol: 'a2a', url: config.cowUrl ?? PEER_COW_URL, token: config.cowToken ?? '', skills: ['host-ops', 'news', 'monitoring', 'family-lab'], tokenEnv: PEER_COW_TOKEN_ENV },
  ]
  const statuses = new Map<string, PeerStatus>(peers.map(peer => [peer.id, { probedAt: Number.NEGATIVE_INFINITY, online: false, failureLogged: false }]))

  /** Log a peer failure once until its next success; the message never contains the token. */
  function noteFailure(peer: PeerDefinition, what: string, error: unknown): void {
    const status = statuses.get(peer.id)!
    status.lastError = error instanceof PeerCallError ? error.message : String((error as Error | undefined)?.message ?? error)
    if (status.failureLogged) return
    status.failureLogged = true
    log(`peer ${what} failed`, { peer: peer.id, error: status.lastError })
  }

  function noteSuccess(peer: PeerDefinition): void {
    const status = statuses.get(peer.id)!
    status.lastError = undefined
    status.failureLogged = false
  }

  /** Probe one peer's agent card unless the cache is fresh; a failure marks it offline, never throws. */
  async function probe(peer: PeerDefinition): Promise<void> {
    const status = statuses.get(peer.id)!
    if (Date.now() - status.probedAt < cardCacheMs) return
    // Stamp before awaiting so a concurrent listing reads the cache instead of double-probing.
    status.probedAt = Date.now()
    try {
      const card = asRecord(await requestJson(agentCardUrl(peer.url), { method: 'GET', timeoutMs: probeTimeoutMs, token: peer.token, fetch }))
      status.online = true
      const name = String(card.name ?? '')
      status.name = name || undefined
      noteSuccess(peer)
      log('peer card refreshed', { peer: peer.id, ...(status.name ? { name: status.name } : {}) })
    } catch (error) {
      status.online = false
      noteFailure(peer, 'card', error)
    }
  }

  const peerList = defineTool({
    name: 'peer_list',
    description: '列出内置的同伴 agent 与在线状态，返回 JSON {peers:[{id,name,url,skills,online,lastError?}]}。在线状态来自 agent card 探测（3s 超时，结果缓存 10 分钟）；单个 peer 离线不影响整体。',
    parameters: obj({}),
    execute: async (_args: PeerListArgs) => {
      // Probes run side by side; each one swallows its own failure into `online:false`.
      await Promise.all(peers.map(peer => probe(peer)))
      const view = peers.map(peer => {
        const status = statuses.get(peer.id)!
        return {
          id: peer.id,
          name: status.name ?? peer.id,
          url: peer.url,
          skills: peer.skills,
          online: status.online,
          ...(status.lastError ? { lastError: status.lastError } : {}),
        }
      })
      return { output: [{ type: 'text', text: JSON.stringify({ peers: view }) }] }
    },
  })

  const peerSend = defineTool({
    name: 'peer_send',
    description: '把一件事完整交给一个同伴 agent 执行，返回 JSON {peer,state,text,taskId,elapsedMs}。state 为 completed/failed/timeout 等；对方仍在执行（TASK_STATE_WORKING）时自动轮询 tasks/get 直到完成或超时。默认 300s 超时、上限 900s；超时返回 taskId，任务仍在对方那边执行。',
    parameters: obj({
      peer: str({ description: '同伴 id：hermes-cc2（编码/运维/记忆/调研）或 cowagent-deb02（deb02 主机/新闻/家庭实验室/盯盘），peer_list 可查在线状态' }),
      text: str({ description: '交给对方的完整任务说明：目标、背景、验收标准都要带齐，不要只给半句话' }),
      contextId: opt(str({ description: '延续上一次对话的 context id；缺省新开一个' })),
      timeoutSec: opt(int({ minimum: 1, maximum: 900, description: '整次调用的超时秒数；默认 300，上限 900' })),
    }),
    execute: async (args: PeerSendArgs) => {
      const peer = peers.find(candidate => candidate.id === args.peer)
      if (!peer) {
        return failure('peer_send', `未知 peer "${args.peer}"；内置同伴：${peers.map(candidate => candidate.id).join(', ')}`)
      }
      if (!peer.token) {
        return failure('peer_send', `peer "${peer.id}" 未配置访问令牌（${peer.tokenEnv}），已拒绝发送；请先在运行环境配置该变量`)
      }
      const budgetMs = Math.min(Math.max((args.timeoutSec ?? Math.round(timeoutMs / 1000)) * 1000, 1_000), PEER_MAX_TIMEOUT_MS)
      const startedAt = Date.now()
      const deadline = startedAt + budgetMs
      const contextId = args.contextId ?? `ctx-${randomUUID().replace(/-/g, '').slice(0, 16)}`
      // The initial request gets the whole budget; each later poll gets whatever is left (with a
      // small floor so the last look right at the deadline is not aborted before it can answer).
      const budget = (): number => Math.max(deadline - Date.now(), pollMs)

      let payload: unknown
      try {
        payload = await withOneRetry(() => requestJson(peer.url, {
          method: 'POST',
          timeoutMs: budget(),
          token: peer.token,
          fetch,
          body: {
            jsonrpc: '2.0',
            id: randomUUID(),
            method: peer.protocol === 'hermes' ? 'SendMessage' : 'message/send',
            params: {
              message: {
                role: peer.protocol === 'hermes' ? 'ROLE_USER' : 'user',
                messageId: `m-${randomUUID()}`,
                contextId,
                parts: [{ kind: 'text', text: args.text }],
              },
            },
          },
        }))
      } catch (error) {
        noteFailure(peer, 'send', error)
        return failure('peer_send', `发送到 peer "${peer.id}" 失败（${error instanceof PeerCallError ? error.message : String(error)}）；可稍后重试或改用另一个 peer`)
      }
      const rpcError = asRecord(payload).error
      if (rpcError) {
        noteFailure(peer, 'send', String(asRecord(rpcError).message ?? 'JSON-RPC 错误'))
        return failure('peer_send', `peer "${peer.id}" 返回错误：${String(asRecord(rpcError).message ?? rpcError)}`)
      }
      noteSuccess(peer)
      let task = taskOf(payload)
      let state = taskState(task)
      const taskId = String(task.id ?? '')
      log('peer send', { peer: peer.id, ...(taskId ? { taskId } : {}) })

      while (PENDING_STATES.has(state)) {
        const left = deadline - Date.now()
        if (left <= 0) break
        await new Promise<void>(resolve => {
          const timer = setTimeout(resolve, Math.min(pollMs, left))
          timer.unref?.()
        })
        try {
          const polled = await withOneRetry(() => requestJson(peer.url, {
            method: 'POST',
            timeoutMs: budget(),
            token: peer.token,
            fetch,
            body: { jsonrpc: '2.0', id: randomUUID(), method: 'tasks/get', params: { id: taskId } },
          }))
          const pollError = asRecord(polled).error
          if (pollError) throw new PeerCallError(String(asRecord(pollError).message ?? pollError), false)
          task = taskOf(polled)
          state = taskState(task)
        } catch (error) {
          noteFailure(peer, 'poll', error)
          return failure('peer_send', `轮询 peer "${peer.id}" 的任务 ${taskId} 失败（${error instanceof PeerCallError ? error.message : String(error)}）；任务可能仍在执行，可稍后重试`)
        }
      }

      const elapsedMs = Date.now() - startedAt
      if (PENDING_STATES.has(state)) {
        log('peer timeout', { peer: peer.id, ...(taskId ? { taskId } : {}), elapsedMs })
        const text = `仍在执行：任务 ${taskId || '(无 id)'} 未在 ${Math.round(budgetMs / 1000)}s 内完成，可稍后带 contextId 重试或查询。`
        return { output: [{ type: 'text', text: JSON.stringify({ peer: peer.id, state: 'timeout', text, taskId, elapsedMs } satisfies PeerSendOutcome) }] }
      }
      const outcome: PeerSendOutcome = { peer: peer.id, state: state || 'unknown', text: textOfTask(task, peer.protocol), taskId, elapsedMs }
      // A failed task is the peer's error text, returned verbatim in the JSON body, flagged for the model.
      if (state === 'failed') {
        return { isError: true, output: [{ type: 'text', text: JSON.stringify(outcome) }] }
      }
      return { output: [{ type: 'text', text: JSON.stringify(outcome) }] }
    },
  })

  return Object.assign(
    defineExtension({ name: 'peers', tools: [peerList, peerSend] }),
    {
      stop: (): void => {
        for (const status of statuses.values()) {
          status.probedAt = Number.NEGATIVE_INFINITY
          status.online = false
          status.failureLogged = false
        }
      },
    },
  )
}
