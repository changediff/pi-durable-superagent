/**
 * The OpenViking memory plugin (design doc §014, cut 1): the worker's read/write access to
 * the shared memory database.
 *
 * Four tools over one small HTTP client: `viking_search` (semantic recall), `viking_read`
 * (abstract/overview/full, falling back to the full read when a file makes the summary
 * endpoints fail), `viking_write` (the single-writer rule enforced as a URI allowlist), and
 * `viking_browse` (directory listing). Every failure comes back as error text so the worker
 * keeps running without memory; transport failures log one line per run. The plugin owns no
 * timers — `stop()` only resets the log dedupe. The API key travels in headers only and never
 * reaches a URL, a log line, or an error message.
 */
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { Extension } from '@earendil-works/pi-durable'
import { arr, int, obj, oneOf, opt, str } from '@earendil-works/pi-schema'

export const OPENVIKING_TOOLS = ['viking_search', 'viking_read', 'viking_write', 'viking_browse'] as const
export const OPENVIKING_DEFAULT_ENDPOINT = 'https://api.vikingdb.cn-beijing.volces.com/openviking'
export const OPENVIKING_DEFAULT_PEER = 'superagent'

/** Request budgets: nothing waits forever inside a tool call; writes get the longest. */
export interface OpenVikingTimeouts {
  searchMs: number
  readMs: number
  writeMs: number
}

const DEFAULT_TIMEOUTS: OpenVikingTimeouts = { searchMs: 15_000, readMs: 15_000, writeMs: 30_000 }
/** `viking_search` result abstracts are clipped to this many characters. */
const SEARCH_ABSTRACT_CAP = 400
/** `viking_read` content caps per level; longer content is truncated with a note. */
const READ_CAPS = { abstract: 1200, overview: 4000, full: 8000 } as const
/** `viking_browse` keeps only the first line of each abstract, clipped to this. */
const BROWSE_ABSTRACT_CAP = 200
const SEARCH_DEFAULT_LIMIT = 5

export type VikingReadLevel = keyof typeof READ_CAPS
export type VikingWriteMode = 'create' | 'replace'

export interface OpenVikingConfig {
  /** OpenViking endpoint, e.g. the default `https://api.vikingdb.cn-beijing.volces.com/openviking`. */
  endpoint: string
  /** API key; sent as both `X-API-Key` and `Authorization: Bearer`. */
  apiKey: string
  /** This agent's peer name, sent as `X-OpenViking-Actor-Peer` on writes; default `superagent`. */
  peer?: string
  /** Tenant headers retried when the server answers 401; both default `default`. */
  account?: string
  user?: string
  /** Request budgets; default search/read 15s, write 30s. */
  timeouts?: Partial<OpenVikingTimeouts>
  /** Structured log; the API key is never logged. */
  log?(message: string, detail?: unknown): void
  /** Injectable fetch (tests); defaults to the global one. */
  fetch?: typeof globalThis.fetch
}

export interface VikingSearchArgs {
  query: string
  limit?: number
  target_uri?: string[]
  context_type?: string[]
}

export interface VikingReadArgs {
  uri: string
  level?: VikingReadLevel
}

export interface VikingWriteArgs {
  uri: string
  content: string
  mode?: VikingWriteMode
}

export interface VikingBrowseArgs {
  uri?: string
}

export type OpenVikingExtension = Extension & {
  /** Nothing to tear down (no timers); resets the once-per-run unreachable log for a restart. */
  readonly stop: () => void
}

/** A request failure already formatted as model-facing text; `unreachable` marks transport errors. */
class OpenVikingError extends Error {
  constructor(message: string, readonly unreachable: boolean) {
    super(message)
  }
}

interface RequestSpec {
  method: 'GET' | 'POST'
  body?: unknown
  timeoutMs: number
  /** Send `X-OpenViking-Actor-Peer` (writes only: the server isolates them into this peer's space). */
  actorPeer?: boolean
}

/** One HTTP conversation with the OpenViking server: auth headers, budgets, and the 401 tenant retry. */
class OpenVikingClient {
  private readonly endpoint: string
  private readonly timeouts: OpenVikingTimeouts
  /** Set once a tenant-header retry succeeded: later requests send them up front, saving the 401 roundtrip. */
  private tenantRequired = false
  private unreachableLogged = false

  constructor(
    private readonly options: { endpoint: string; apiKey: string; peer: string; account: string; user: string; log(message: string, detail?: unknown): void; fetch: typeof globalThis.fetch },
    timeouts: Partial<OpenVikingTimeouts> = {},
  ) {
    this.endpoint = options.endpoint.replace(/\/+$/, '')
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...timeouts }
  }

  /** Reset the once-per-run unreachable log (a restarted run logs the next failure again). */
  reset(): void {
    this.unreachableLogged = false
  }

  /** Run one request; resolves with the parsed JSON body, throws `OpenVikingError` on any failure. */
  async request(path: string, spec: RequestSpec): Promise<unknown> {
    const url = `${this.endpoint}${path}`
    const payload = spec.body === undefined ? undefined : JSON.stringify(spec.body)
    const headers: Record<string, string> = {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      'x-api-key': this.options.apiKey,
      authorization: `Bearer ${this.options.apiKey}`,
      ...(spec.actorPeer && this.options.peer ? { 'x-openviking-actor-peer': this.options.peer } : {}),
      ...(this.tenantRequired ? this.tenantHeaders() : {}),
    }
    let response
    try {
      response = await this.send(url, spec, headers, payload)
      if (response.status === 401 && !this.tenantRequired) {
        // Some deployments refuse every call until the tenant headers are explicit; retry once with them.
        const retried = await this.send(url, spec, { ...headers, ...this.tenantHeaders() }, payload)
        if (retried.ok) this.tenantRequired = true
        if (retried.status !== 401) response = retried
      }
    } catch (error) {
      throw this.unreachableError(error, spec.timeoutMs)
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new OpenVikingError(`OpenViking 服务端错误：HTTP ${response.status}${snippet(detail)}`, false)
    }
    const text = await response.text()
    try {
      return text ? (JSON.parse(text) as unknown) : undefined
    } catch {
      throw new OpenVikingError(`OpenViking 返回非 JSON（HTTP ${response.status}）${snippet(text)}`, false)
    }
  }

  private tenantHeaders(): Record<string, string> {
    return { 'x-openviking-account': this.options.account, 'x-openviking-user': this.options.user }
  }

  /** One fetch under an abort budget; the timer is always cleared, so nothing leaks past the call. */
  private async send(url: string, spec: RequestSpec, headers: Record<string, string>, payload: string | undefined): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs)
    timer.unref?.()
    try {
      return await this.options.fetch(url, { method: spec.method, headers, body: payload, signal: controller.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  /** Format a transport failure, logging it once per run. */
  private unreachableError(error: unknown, timeoutMs: number): OpenVikingError {
    const cause = (error as { cause?: { message?: string } } | undefined)?.cause
    const reason = (error as { name?: string } | undefined)?.name === 'AbortError'
      ? `请求超时（${Math.round(timeoutMs / 1000)}s）`
      : String(cause?.message ?? (error as Error | undefined)?.message ?? error)
    if (!this.unreachableLogged) {
      this.unreachableLogged = true
      this.options.log('OpenViking 不可达', reason)
    }
    return new OpenVikingError(`OpenViking 不可达：${reason}`, true)
  }
}

const snippet = (text: string): string => {
  const trimmed = text.trim().replace(/\s+/g, ' ')
  return trimmed ? `：${trimmed.slice(0, 160)}` : ''
}

/** The `result` field of an OpenViking response, whatever shape the endpoint gives it. */
function resultOf(payload: unknown): unknown {
  if (payload !== null && typeof payload === 'object' && 'result' in payload) {
    return (payload as { result: unknown }).result
  }
  return payload
}

/** `result.content`, or the whole `result` when the endpoint returns a bare string. */
function contentOf(result: unknown): string {
  if (typeof result === 'string') return result
  const content = (result as { content?: unknown } | null | undefined)?.content
  return typeof content === 'string' ? content : ''
}

/** `result.memories[]` as loose records; anything else is an empty result. */
function memoriesOf(payload: unknown): Record<string, unknown>[] {
  const memories = (resultOf(payload) as { memories?: unknown } | null | undefined)?.memories
  return Array.isArray(memories)
    ? memories.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
    : []
}

/** `result[]` of a directory listing as loose records. */
function entriesOf(payload: unknown): Record<string, unknown>[] {
  const result = resultOf(payload)
  return Array.isArray(result)
    ? result.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
    : []
}

/** `result.content_updated === true` is the only outcome the server reports as a stored write. */
function contentUpdated(payload: unknown): boolean {
  return (resultOf(payload) as { content_updated?: unknown } | null | undefined)?.content_updated === true
}

const clip = (text: string, cap: number): string => (text.length <= cap ? text : text.slice(0, cap))

/** Clip to a read level's cap, annotating the cut so the model knows the text is partial. */
function clipWithNote(text: string, level: VikingReadLevel): string {
  const cap = READ_CAPS[level]
  if (text.length <= cap) return text
  return `${text.slice(0, cap)}\n…[已截断：原文共 ${text.length} 字，${level} 层级上限 ${cap} 字]`
}

const firstLine = (text: string): string => (text.split(/\r?\n/)[0] ?? '').trim().slice(0, BROWSE_ABSTRACT_CAP)

export type VikingWriteScope = { ok: true; root: 'memories' | 'peer' } | { ok: false; reason: string }

/**
 * The single-writer rule as a URI check: this plugin writes only the shared memory root
 * `viking://user/<user>/memories/**` and its own peer space `viking://user/<user>/peers/<peer>/**`.
 * Everything else — resources, identity, other peers' spaces, relative-path escapes — is refused
 * before any request leaves the process.
 */
export function writableVikingUri(uri: string, user: string, peer: string): VikingWriteScope {
  const segments = uri.split('/')
  if (segments.includes('..') || segments.includes('.')) return { ok: false, reason: '路径含相对段' }
  const memoryRoot = `viking://user/${user}/memories`
  const peerRoot = `viking://user/${user}/peers/${peer}`
  if (uri.startsWith(`${memoryRoot}/`)) return { ok: true, root: 'memories' }
  if (uri.startsWith(`${peerRoot}/`)) return { ok: true, root: 'peer' }
  return { ok: false, reason: `仅允许 ${memoryRoot}/** 与 ${peerRoot}/**` }
}

/** A tool failure as plain error text: the worker keeps its turn, nothing throws past the tool. */
const failure = (tool: string, error: unknown): { isError: true; output: [{ type: 'text'; text: string }] } => ({
  isError: true,
  output: [{
    type: 'text',
    text: `${tool}: ${error instanceof OpenVikingError ? error.message : String((error as Error | undefined)?.message ?? error)}`,
  }],
})

/** Build the OpenViking memory extension from its configuration. */
export function createOpenVikingExtension(config: OpenVikingConfig): OpenVikingExtension {
  const log = config.log ?? (() => {})
  const client = new OpenVikingClient(
    {
      endpoint: config.endpoint,
      apiKey: config.apiKey,
      peer: config.peer ?? OPENVIKING_DEFAULT_PEER,
      account: config.account ?? 'default',
      user: config.user ?? 'default',
      log,
      fetch: config.fetch ?? ((input, init) => fetch(input, init)),
    },
    config.timeouts,
  )
  const user = config.user ?? 'default'
  const peer = config.peer ?? OPENVIKING_DEFAULT_PEER
  const timeouts: OpenVikingTimeouts = { ...DEFAULT_TIMEOUTS, ...config.timeouts }

  const search = defineTool({
    name: 'viking_search',
    description: '在 OpenViking 共享记忆库中检索，返回 JSON {count, hits:[{uri, score, abstract, context_type}]}。规划任务前先搜已知事实、偏好、实体与事件；写新记忆前先搜避免重复。',
    parameters: obj({
      query: str({ description: '检索词或自然语言问题' }),
      limit: opt(int({ minimum: 1, maximum: 50, description: '返回条数上限；默认 5' })),
      target_uri: opt(arr(str(), { description: '只在这些 URI 前缀下检索，如 ["viking://user/default/memories/"]' })),
      context_type: opt(arr(str(), { description: '限定类型，如 ["memory"] 或 ["resource"]；默认两者' })),
    }),
    execute: async (args: VikingSearchArgs) => {
      const limit = args.limit ?? SEARCH_DEFAULT_LIMIT
      let payload: unknown
      try {
        payload = await client.request('/api/v1/search/find', {
          method: 'POST',
          timeoutMs: timeouts.searchMs,
          body: {
            query: args.query,
            limit,
            score_threshold: 0,
            context_type: args.context_type?.length ? args.context_type : ['memory', 'resource'],
            ...(args.target_uri?.length ? { target_uri: args.target_uri } : {}),
          },
        })
      } catch (error) {
        return failure('viking_search', error)
      }
      const hits = memoriesOf(payload).slice(0, limit).map(entry => ({
        uri: String(entry.uri ?? ''),
        score: typeof entry.score === 'number' ? entry.score : 0,
        abstract: clip(String(entry.abstract ?? ''), SEARCH_ABSTRACT_CAP),
        context_type: String(entry.context_type ?? ''),
      }))
      return { output: [{ type: 'text', text: JSON.stringify({ count: hits.length, hits }) }] }
    },
  })

  const read = defineTool({
    name: 'viking_read',
    description: '读一条 OpenViking 记忆，返回 JSON {uri, level, content}。level=abstract（约 1200 字）/ overview（约 4000 字，默认）/ full（约 8000 字）；读文件时摘要端点会失败并自动回退全文，超出上限的内容被截断并注明。',
    parameters: obj({
      uri: str({ description: 'viking:// URI，来自 viking_search 的命中或 viking_browse 的条目' }),
      level: opt(oneOf(['abstract', 'overview', 'full'], { description: '读取层级；默认 overview' })),
    }),
    execute: async (args: VikingReadArgs) => {
      const level: VikingReadLevel = args.level ?? 'overview'
      const encoded = encodeURIComponent(args.uri)
      let content: string
      try {
        if (level === 'full') {
          content = contentOf(resultOf(await client.request(`/api/v1/content/read?uri=${encoded}`, { method: 'GET', timeoutMs: timeouts.readMs })))
        } else {
          try {
            content = contentOf(resultOf(await client.request(`/api/v1/content/${level}?uri=${encoded}`, { method: 'GET', timeoutMs: timeouts.readMs })))
          } catch (error) {
            // Files make the summary endpoints fail (500/412): fall back to the full read, capped for the level.
            if (error instanceof OpenVikingError && error.unreachable) throw error
            content = contentOf(resultOf(await client.request(`/api/v1/content/read?uri=${encoded}`, { method: 'GET', timeoutMs: timeouts.readMs })))
          }
        }
      } catch (error) {
        return failure('viking_read', error)
      }
      return { output: [{ type: 'text', text: JSON.stringify({ uri: args.uri, level, content: clipWithNote(content, level) }) }] }
    },
  })

  const write = defineTool({
    name: 'viking_write',
    description: `写一条 OpenViking 记忆，返回 JSON {status:"written", uri, bytes}。只允许 viking://user/${user}/memories/**（共享根）与 viking://user/${user}/peers/${peer}/**（自己的空间），其它前缀一律拒绝。mode=create 仅新建，已存在时失败；mode=replace 覆盖。`,
    parameters: obj({
      uri: str({ description: '目标 viking:// URI（必须落在允许的前缀内）' }),
      content: str({ description: '写入的完整 Markdown 文本' }),
      mode: opt(oneOf(['create', 'replace'], { description: 'create 仅新建（默认）；replace 覆盖已有内容' })),
    }),
    execute: async (args: VikingWriteArgs) => {
      const writable = writableVikingUri(args.uri, user, peer)
      if (!writable.ok) {
        return {
          isError: true,
          output: [{ type: 'text', text: `viking_write: 拒绝写入 ${args.uri}（${writable.reason}）；这保护了 resources、identity 与其他 peer 的空间。` }],
        }
      }
      const mode: VikingWriteMode = args.mode ?? 'create'
      let payload: unknown
      try {
        payload = await client.request('/api/v1/content/write', {
          method: 'POST',
          timeoutMs: timeouts.writeMs,
          actorPeer: true,
          body: { uri: args.uri, content: args.content, mode, wait: true },
        })
      } catch (error) {
        return failure('viking_write', error)
      }
      if (!contentUpdated(payload)) {
        return {
          isError: true,
          output: [{ type: 'text', text: `viking_write: 写入未生效（content_updated=false）：${args.uri}；mode=${mode} 下已存在时请改用 replace。` }],
        }
      }
      return { output: [{ type: 'text', text: JSON.stringify({ status: 'written', uri: args.uri, bytes: Buffer.byteLength(args.content, 'utf8') }) }] }
    },
  })

  const browse = defineTool({
    name: 'viking_browse',
    description: `列一个 OpenViking 目录，返回 JSON {count, entries:[{uri, isDir, abstract}]}（abstract 取首行）。默认列 viking://user/${user}/peers/。`,
    parameters: obj({
      uri: opt(str({ description: '要列的目录 URI；默认自己的 peers 目录' })),
    }),
    execute: async (args: VikingBrowseArgs) => {
      const uri = args.uri ?? `viking://user/${user}/peers/`
      let payload: unknown
      try {
        payload = await client.request(`/api/v1/fs/ls?uri=${encodeURIComponent(uri)}`, { method: 'GET', timeoutMs: timeouts.readMs })
      } catch (error) {
        return failure('viking_browse', error)
      }
      const entries = entriesOf(payload).map(entry => ({
        uri: String(entry.uri ?? ''),
        isDir: entry.isDir === true,
        abstract: firstLine(String(entry.abstract ?? '')),
      }))
      return { output: [{ type: 'text', text: JSON.stringify({ count: entries.length, entries }) }] }
    },
  })

  return Object.assign(
    defineExtension({ name: 'openviking', tools: [search, read, write, browse] }),
    { stop: (): void => { client.reset() } },
  )
}
