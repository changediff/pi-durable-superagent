/**
 * Tool-level checks for the OpenViking memory plugin (design doc §014, cut 1): search / read /
 * write / browse against an injected fake fetch — zero network. Covers the server contract
 * shapes, the file-read fallback, the single-writer URI allowlist (refused before any request),
 * timeouts and 5xx as plain error text with the once-per-run unreachable log, the 401 tenant
 * retry, and the runtime switch that registers the tools only under `SUP_OPENVIKING=on`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOpenVikingExtension, OPENVIKING_TOOLS, type OpenVikingConfig, type OpenVikingExtension } from '../src/plugin/openviking.ts'
import { loadConfig } from '../src/pi/config.ts'
import { PiSuperagentRuntime } from '../src/pi/runtime.ts'
import { MemoryChannel } from '../src/pi/channel.ts'

const ENDPOINT = 'https://ov.test/openviking'
/** Fast budgets so the timeout test finishes in milliseconds instead of 15s. */
const FAST = { searchMs: 30, readMs: 30, writeMs: 30 }

type Recorded = { url: string; init: RequestInit }

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

let directory: string
let calls: Recorded[]
let responder: (url: string, init: RequestInit) => Promise<Response> | Response
let log: ReturnType<typeof vi.fn<(message: string, detail?: unknown) => void>>

/** The injected fetch: records every call, then hands it to the current responder. Like the real
 * fetch, an aborted signal rejects even while the responder hangs. */
const fakeFetch = (async (url: unknown, init?: RequestInit): Promise<Response> => {
  const record = { url: String(url), init: init ?? {} }
  calls.push(record)
  const aborted = new Promise<never>((_, reject) => {
    if (init?.signal?.aborted) reject(new DOMException('Aborted', 'AbortError'))
    else init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  })
  return await Promise.race([Promise.resolve(responder(record.url, record.init)), aborted])
}) as typeof fetch

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'sup-openviking-'))
  calls = []
  log = vi.fn<(message: string, detail?: unknown) => void>()
  responder = () => jsonResponse({})
})

const build = (over: Partial<OpenVikingConfig> = {}): OpenVikingExtension =>
  createOpenVikingExtension({ endpoint: ENDPOINT, apiKey: 'test-key', log, fetch: fakeFetch, timeouts: FAST, ...over })

const toolOf = (extension: OpenVikingExtension, name: string) => {
  const tool = extension.tools!.find(candidate => candidate.name === name)
  expect(tool).toBeDefined()
  return tool!
}

type ToolResult = { isError?: boolean; output?: { type: string; text: string }[] }
const run = async (extension: OpenVikingExtension, name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  await toolOf(extension, name).execute(args, {} as never, {} as never) as ToolResult

const view = (result: ToolResult): Record<string, unknown> => JSON.parse(result.output![0]!.text)
const headersOf = (record: Recorded): Headers => new Headers(record.init.headers as Record<string, string>)

describe('the openviking plugin tools', () => {
  it('viking_search returns hit structures with the abstract clipped to 400 chars', async () => {
    responder = () => jsonResponse({ result: { memories: [
      { uri: 'viking://user/default/memories/entities/用户/张三.md', score: 0.87, level: 'overview', abstract: 'a'.repeat(600), context_type: 'memory', tags: ['人'] },
      { uri: 'viking://user/default/memories/events/2026/11/19/deploy.md', score: 0.42, abstract: '部署事件', context_type: 'memory' },
    ] } })
    const extension = build()
    const result = await run(extension, 'viking_search', { query: '张三' })
    expect(result.isError).toBeFalsy()
    expect(view(result)).toEqual({
      count: 2,
      hits: [
        { uri: 'viking://user/default/memories/entities/用户/张三.md', score: 0.87, abstract: 'a'.repeat(400), context_type: 'memory' },
        { uri: 'viking://user/default/memories/events/2026/11/19/deploy.md', score: 0.42, abstract: '部署事件', context_type: 'memory' },
      ],
    })
    // The request follows the server contract, with both auth headers and no key in the URL.
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.url).toBe(`${ENDPOINT}/api/v1/search/find`)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ query: '张三', limit: 5, score_threshold: 0, context_type: ['memory', 'resource'] })
    expect(headersOf(calls[0]!).get('x-api-key')).toBe('test-key')
    expect(headersOf(calls[0]!).get('authorization')).toBe('Bearer test-key')
    expect(calls[0]!.url).not.toContain('test-key')

    // Optional filters pass through.
    await run(extension, 'viking_search', { query: 'x', limit: 3, target_uri: ['viking://user/default/memories/'], context_type: ['memory'] })
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
      query: 'x', limit: 3, score_threshold: 0, context_type: ['memory'], target_uri: ['viking://user/default/memories/'],
    })
  })

  it('viking_search turns timeouts into error text, never a throw, and logs unreachable once per run', async () => {
    responder = () => new Promise<Response>(() => {}) // hangs until the abort budget fires
    const extension = build()
    const first = await run(extension, 'viking_search', { query: 'x' })
    expect(first.isError).toBe(true)
    expect(first.output![0]!.text).toContain('viking_search: OpenViking 不可达')
    expect(first.output![0]!.text).toContain('超时')
    const second = await run(extension, 'viking_search', { query: 'y' })
    expect(second.isError).toBe(true)
    const unreachable = log.mock.calls.filter(([message]) => String(message).includes('不可达'))
    expect(unreachable.length).toBe(1)
  })

  it('viking_search turns a 500 into error text without throwing', async () => {
    responder = () => jsonResponse({ message: 'internal error' }, 500)
    const result = await run(build(), 'viking_search', { query: 'x' })
    expect(result.isError).toBe(true)
    expect(result.output![0]!.text).toContain('HTTP 500')
  })

  it('viking_read falls back to content/read when the summary endpoint fails on a file', async () => {
    const answers = [
      () => jsonResponse({ message: 'not summary-able' }, 500),
      () => jsonResponse({ result: { content: '# 张三\n后端工程师，偏好简洁回复。' } }),
    ]
    let which = 0
    responder = () => answers[Math.min(which++, answers.length - 1)]!()
    const uri = 'viking://user/default/memories/entities/用户/张三.md'
    const result = await run(build(), 'viking_read', { uri })
    expect(result.isError).toBeFalsy()
    expect(view(result)).toEqual({ uri, level: 'overview', content: '# 张三\n后端工程师，偏好简洁回复。' })
    expect(calls[0]!.url).toContain('/api/v1/content/overview?uri=')
    expect(calls[1]!.url).toContain('/api/v1/content/read?uri=')
    expect(decodeURIComponent(calls[1]!.url)).toContain(uri)
    expect(calls).toHaveLength(2)
  })

  it('viking_read clips content to the level cap with a truncation note', async () => {
    responder = () => jsonResponse({ result: '全文'.repeat(5000) }) // result itself is the string
    const result = await run(build(), 'viking_read', { uri: 'viking://user/default/memories/a.md', level: 'full' })
    const read = view(result)
    expect(String(read.content).length).toBeGreaterThan(8000)
    expect(String(read.content).startsWith('全文'.repeat(4000))).toBe(true)
    expect(read.level).toBe('full')
    expect(String(read.content)).toContain('已截断')
    expect(calls[0]!.url).toContain('/api/v1/content/read?uri=')
  })

  it('viking_read with level=abstract reads the abstract endpoint directly', async () => {
    responder = () => jsonResponse({ result: { content: '摘要' } })
    const result = await run(build(), 'viking_read', { uri: 'viking://user/default/memories/entities/用户/', level: 'abstract' })
    expect(view(result)).toEqual({ uri: 'viking://user/default/memories/entities/用户/', level: 'abstract', content: '摘要' })
    expect(calls[0]!.url).toContain('/api/v1/content/abstract?uri=')
  })

  it('viking_write posts the contract body with the actor-peer header and reports bytes', async () => {
    responder = () => jsonResponse({ result: { content_updated: true } })
    const extension = build()
    const content = '# hermes\n技能：编码、运维'
    const uri = 'viking://user/default/memories/entities/智能体/hermes.md'
    const result = await run(extension, 'viking_write', { uri, content, mode: 'replace' })
    expect(result.isError).toBeFalsy()
    expect(view(result)).toEqual({ status: 'written', uri, bytes: Buffer.byteLength(content, 'utf8') })
    expect(calls[0]!.init.method).toBe('POST')
    expect(calls[0]!.url).toBe(`${ENDPOINT}/api/v1/content/write`)
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ uri, content, mode: 'replace', wait: true })
    expect(headersOf(calls[0]!).get('x-openviking-actor-peer')).toBe('superagent')

    // Default mode is create, and the plugin's own peer space is writable too.
    const own = 'viking://user/default/peers/superagent/notes/2026-11-19.md'
    const second = await run(extension, 'viking_write', { uri: own, content: 'note' })
    expect(second.isError).toBeFalsy()
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ uri: own, content: 'note', mode: 'create', wait: true })
  })

  it('viking_write treats content_updated=false as a failure', async () => {
    responder = () => jsonResponse({ result: { content_updated: false } })
    const result = await run(build(), 'viking_write', { uri: 'viking://user/default/memories/x.md', content: 'x' })
    expect(result.isError).toBe(true)
    expect(result.output![0]!.text).toContain('content_updated=false')
  })

  it('viking_write refuses URIs outside its two roots without sending any request', async () => {
    responder = vi.fn(() => jsonResponse({ result: { content_updated: true } }))
    const refused = [
      'viking://resources/indices/people.md',
      'viking://user/default/identity.md',
      'viking://user/default/peers/hermes/notes.md', // another peer's space
      'viking://user/default/memories/../identity.md', // relative escape
    ]
    for (const uri of refused) {
      const result = await run(build(), 'viking_write', { uri, content: 'x' })
      expect(result.isError).toBe(true)
      expect(result.output![0]!.text).toContain('拒绝')
    }
    expect(responder).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('viking_browse lists a slimmed directory view and defaults to the peers root', async () => {
    responder = () => jsonResponse({ result: [
      { uri: 'viking://user/default/peers/superagent/', isDir: true, size: 0, modTime: '2026-11-19T00:00:00Z', abstract: 'superagent 自己的空间\n第二行不出现在结果里' },
      { uri: 'viking://user/default/memories/entities/用户/张三.md', isDir: false, size: 120, modTime: '2026-11-19T00:00:00Z', abstract: '张三：后端工程师' },
    ] })
    const result = await run(build(), 'viking_browse', {})
    expect(result.isError).toBeFalsy()
    expect(view(result)).toEqual({
      count: 2,
      entries: [
        { uri: 'viking://user/default/peers/superagent/', isDir: true, abstract: 'superagent 自己的空间' },
        { uri: 'viking://user/default/memories/entities/用户/张三.md', isDir: false, abstract: '张三：后端工程师' },
      ],
    })
    expect(calls[0]!.url).toContain('/api/v1/fs/ls?uri=')
    expect(decodeURIComponent(calls[0]!.url)).toContain('viking://user/default/peers/')
  })

  it('retries once with tenant headers when the server answers 401, and remembers it', async () => {
    const answers = [
      () => new Response('unauthorized', { status: 401 }),
      () => jsonResponse({ result: { memories: [{ uri: 'viking://user/default/memories/a.md', score: 1, abstract: 's', context_type: 'memory' }] } }),
      () => jsonResponse({ result: { memories: [] } }),
    ]
    let which = 0
    responder = () => answers[Math.min(which++, answers.length - 1)]!()
    const extension = build()
    const first = await run(extension, 'viking_search', { query: 'a' })
    expect(first.isError).toBeFalsy()
    expect(view(first)).toEqual({ count: 1, hits: [{ uri: 'viking://user/default/memories/a.md', score: 1, abstract: 's', context_type: 'memory' }] })
    expect(headersOf(calls[0]!).get('x-openviking-account')).toBeNull()
    expect(headersOf(calls[1]!).get('x-openviking-account')).toBe('default')
    expect(headersOf(calls[1]!).get('x-openviking-user')).toBe('default')
    // The retry succeeded, so the next request carries the tenant headers up front: one call, no 401 roundtrip.
    await run(extension, 'viking_search', { query: 'b' })
    expect(calls).toHaveLength(3)
    expect(headersOf(calls[2]!).get('x-openviking-account')).toBe('default')
  })
})

describe('the runtime switch', () => {
  const runtimeWith = (on: boolean): PiSuperagentRuntime => {
    const cfg = loadConfig({
      SUP_STATE_DIR: join(directory, 'state'),
      SUP_WORK_DIR: join(directory, 'work'),
      SUP_HARNESS_DIR: join(directory, 'harness'),
      SUP_EVAL_MODE: 'off',
      ...(on ? { SUP_OPENVIKING: 'on', SUP_OPENVIKING_API_KEY: 'rt-key' } : {}),
    })
    return new PiSuperagentRuntime(cfg, { channel: new MemoryChannel(), log: () => {} })
  }

  it('registers no viking tools when SUP_OPENVIKING is unset', async () => {
    const runtime = runtimeWith(false)
    const names = runtime.registry.snapshot().tools().map(({ tool }) => tool.name)
    expect(names.filter(name => name.startsWith('viking_'))).toEqual([])
    expect(runtime.openviking).toBeUndefined()
    await runtime.stop()
  })

  it('installs the four viking tools when SUP_OPENVIKING=on', async () => {
    const runtime = runtimeWith(true)
    const names = runtime.registry.snapshot().tools().map(({ tool }) => tool.name)
    for (const name of OPENVIKING_TOOLS) expect(names).toContain(name)
    expect(runtime.openviking).toBeDefined()
    runtime.openviking!.stop()
    await runtime.stop()
  })

  it('falls back to OPENVIKING_API_KEY when SUP_OPENVIKING_API_KEY is empty', () => {
    const cfg = loadConfig({
      SUP_STATE_DIR: directory,
      SUP_WORK_DIR: directory,
      SUP_HARNESS_DIR: directory,
      SUP_OPENVIKING: 'on',
      OPENVIKING_API_KEY: 'legacy-key',
    })
    expect(cfg.openviking.apiKey).toBe('legacy-key')
    expect(cfg.openviking.enabled).toBe(true)
    const off = loadConfig({ SUP_STATE_DIR: directory })
    expect(off.openviking.enabled).toBe(false)
    expect(off.openviking.endpoint).toBe('https://api.vikingdb.cn-beijing.volces.com/openviking')
    expect(off.openviking.peer).toBe('superagent')
  })
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})
