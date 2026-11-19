/**
 * Tool-level checks for the peers plugin (design doc §014, cut 2): `peer_list` / `peer_send`
 * against an injected fake fetch and a fake clock — zero network. Covers the agent-card probes
 * (origin-derived well-known URL, one peer offline never failing the listing, the 10-minute
 * cache), both wire protocols (`SendMessage`/`ROLE_USER` vs `message/send`/`user`), the two
 * reply shapes (`status.message.parts[].text` vs `artifacts[].parts[].text`), `tasks/get`
 * polling under `TASK_STATE_WORKING`, the timeout that keeps the `taskId`, the fail-fast errors
 * that never leave the process, and the runtime switch that installs the tools and adds the
 * matching worker-brief sections only under `SUP_PEERS=on` / `SUP_OPENVIKING=on`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createPeersExtension,
  PEER_COW_URL,
  PEER_HERMES_URL,
  PEERS_TOOLS,
  type PeersConfig,
  type PeersExtension,
} from '../src/plugin/peers.ts'
import { loadConfig } from '../src/pi/config.ts'
import { PiSuperagentRuntime } from '../src/pi/runtime.ts'
import { MemoryChannel } from '../src/pi/channel.ts'

const HERMES_CARD = `${new URL(PEER_HERMES_URL).origin}/.well-known/agent-card.json`
const COW_CARD = `${new URL(PEER_COW_URL).origin}/.well-known/agent-card.json`
/** Fast poll cadence so the fake clock only has to advance a few seconds. */
const POLL_MS = 1_000

type Recorded = { url: string; init: RequestInit }

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A JSON-RPC answer wrapping the task the way this server (and cow) does: `{result:{task}}`. */
const rpcTask = (task: unknown): unknown => ({ jsonrpc: '2.0', id: 'rpc-1', result: { task } })

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
  directory = mkdtempSync(join(tmpdir(), 'sup-peers-'))
  calls = []
  log = vi.fn<(message: string, detail?: unknown) => void>()
  responder = () => jsonResponse({})
})

const build = (over: PeersConfig = {}): PeersExtension =>
  createPeersExtension({ hermesToken: 'hermes-secret', cowToken: 'cow-secret', log, fetch: fakeFetch, pollMs: POLL_MS, ...over })

const toolOf = (extension: PeersExtension, name: string) => {
  const tool = extension.tools!.find(candidate => candidate.name === name)
  expect(tool).toBeDefined()
  return tool!
}

type ToolResult = { isError?: boolean; output?: { type: string; text: string }[] }
const run = async (extension: PeersExtension, name: string, args: Record<string, unknown>): Promise<ToolResult> =>
  await toolOf(extension, name).execute(args, {} as never, {} as never) as ToolResult

const view = (result: ToolResult): Record<string, unknown> => JSON.parse(result.output![0]!.text)
const headersOf = (record: Recorded): Headers => new Headers(record.init.headers as Record<string, string>)
const bodyOf = (record: Recorded): Record<string, unknown> => JSON.parse(String(record.init.body)) as Record<string, unknown>

/** Answer cards by origin: both healthy by default. */
const cards = (hermes: () => Response, cow: () => Response): void => {
  responder = (url) => (url === HERMES_CARD ? hermes() : url === COW_CARD ? cow() : jsonResponse({ error: 'not found' }, 404))
}

describe('peer_list', () => {
  it('reports both peers online with their builtin skills, probing the origin well-known cards', async () => {
    cards(
      () => jsonResponse({ name: 'hermes (cc2)', url: PEER_HERMES_URL, skills: ['whatever the card says'] }),
      () => jsonResponse({ name: '汤圆 deb02', url: PEER_COW_URL }),
    )
    const result = await run(build(), 'peer_list', {})
    expect(result.isError).toBeFalsy()
    expect(view(result)).toEqual({
      peers: [
        { id: 'hermes-cc2', name: 'hermes (cc2)', url: PEER_HERMES_URL, skills: ['coding', 'ops', 'memory', 'research'], online: true },
        { id: 'cowagent-deb02', name: '汤圆 deb02', url: PEER_COW_URL, skills: ['host-ops', 'news', 'monitoring', 'family-lab'], online: true },
      ],
    })
    // Discovery follows the origin of each peer URL, whatever path the A2A endpoint itself lives on.
    expect(calls.map(call => call.url).sort()).toEqual([HERMES_CARD, COW_CARD].sort())
    for (const call of calls) {
      expect(call.init.method).toBe('GET')
      expect(headersOf(call).get('authorization')).toMatch(/^Bearer /)
    }
  })

  it('marks one peer offline on a 500 while the other stays online, and the listing still succeeds', async () => {
    cards(
      () => jsonResponse({ message: 'boom' }, 500),
      () => jsonResponse({ name: '汤圆 deb02' }),
    )
    const result = await run(build(), 'peer_list', {})
    expect(result.isError).toBeFalsy()
    const listed = view(result).peers as { id: string; online: boolean; lastError?: string; name: string }[]
    const hermes = listed.find(peer => peer.id === 'hermes-cc2')!
    const cow = listed.find(peer => peer.id === 'cowagent-deb02')!
    expect(hermes.online).toBe(false)
    expect(hermes.lastError).toContain('HTTP 500')
    expect(hermes.name).toBe('hermes-cc2') // no card, so the id stands in for the name
    expect(cow.online).toBe(true)
    expect(cow.lastError).toBeUndefined()
  })

  it('does not re-probe a cached card within 10 minutes, and re-probes after the cache expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      cards(() => jsonResponse({ name: 'hermes (cc2)' }), () => jsonResponse({ name: '汤圆 deb02' }))
      const extension = build()
      await run(extension, 'peer_list', {})
      await run(extension, 'peer_list', {})
      expect(calls.filter(call => call.url === HERMES_CARD)).toHaveLength(1)
      expect(calls.filter(call => call.url === COW_CARD)).toHaveLength(1)
      // The cache holds the probe result for exactly its lifetime; only then does the next call re-probe.
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000)
      await run(extension, 'peer_list', {})
      expect(calls.filter(call => call.url === HERMES_CARD)).toHaveLength(2)
      expect(calls.filter(call => call.url === COW_CARD)).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('peer_send', () => {
  it('speaks the hermes protocol and reads status.message.parts[0].text', async () => {
    responder = (url, init) => {
      expect(url).toBe(PEER_HERMES_URL)
      expect((JSON.parse(String(init.body)) as { method: string }).method).toBe('SendMessage')
      return jsonResponse(rpcTask({ id: 'task-h1', contextId: 'ctx-abc', status: { state: 'TASK_STATE_COMPLETED', message: { role: 'ROLE_AGENT', parts: [{ kind: 'text', text: '部署完成：3 台主机' }] } } }))
    }
    const result = await run(build(), 'peer_send', { peer: 'hermes-cc2', text: '把 cc2 上的服务部署到最新版' })
    expect(result.isError).toBeFalsy()
    const outcome = view(result)
    expect(outcome.peer).toBe('hermes-cc2')
    expect(outcome.state).toBe('completed')
    expect(outcome.text).toBe('部署完成：3 台主机')
    expect(outcome.taskId).toBe('task-h1')
    expect(typeof outcome.elapsedMs).toBe('number')
    // The request follows the hermes contract: JSON-RPC SendMessage with a ROLE_USER text message.
    const request = bodyOf(calls[0]!)
    expect(request.jsonrpc).toBe('2.0')
    expect(typeof request.id).toBe('string')
    const message = (request.params as { message: Record<string, unknown> }).message
    expect(message.role).toBe('ROLE_USER')
    expect(String(message.messageId)).toMatch(/^m-/)
    expect(String(message.contextId)).toMatch(/^ctx-/)
    expect(message.parts).toEqual([{ kind: 'text', text: '把 cc2 上的服务部署到最新版' }])
    expect(headersOf(calls[0]!).get('authorization')).toBe('Bearer hermes-secret')
  })

  it('speaks the a2a protocol and falls back to artifacts[].parts[].text when the status carries no message', async () => {
    responder = () => jsonResponse({
      jsonrpc: '2.0',
      id: 'rpc-2',
      // cow answers with the task as the bare result, completed, text only in artifacts.
      result: { id: 'task-c1', contextId: 'ctx-cow', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'a1', parts: [{ kind: 'text', text: '磁盘已清理，释放 12G' }] }, { artifactId: 'a2', parts: [{ kind: 'text', text: '第二段' }] }] },
    })
    const result = await run(build(), 'peer_send', { peer: 'cowagent-deb02', text: '清理 deb02 磁盘', contextId: 'ctx-cow-42' })
    expect(result.isError).toBeFalsy()
    expect(view(result)).toMatchObject({ peer: 'cowagent-deb02', state: 'completed', text: '磁盘已清理，释放 12G\n第二段', taskId: 'task-c1' })
    const request = bodyOf(calls[0]!)
    expect(request.method).toBe('message/send')
    const message = (request.params as { message: Record<string, unknown> }).message
    expect(message.role).toBe('user')
    expect(message.contextId).toBe('ctx-cow-42')
    expect(headersOf(calls[0]!).get('authorization')).toBe('Bearer cow-secret')
  })

  it('polls tasks/get while the peer answers TASK_STATE_WORKING, until completed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      let polls = 0
      responder = (_url, init) => {
        const body = JSON.parse(String(init.body)) as { method: string; params: { id: string } }
        if (body.method !== 'tasks/get') {
          return jsonResponse(rpcTask({ id: 'task-h7', status: { state: 'TASK_STATE_WORKING', message: { parts: [{ kind: 'text', text: '已受理' }] } } }))
        }
        polls += 1
        return polls < 3
          ? jsonResponse(rpcTask({ id: body.params.id, status: { state: 'TASK_STATE_WORKING' } }))
          : jsonResponse(rpcTask({ id: body.params.id, status: { state: 'TASK_STATE_COMPLETED', message: { parts: [{ kind: 'text', text: '部署完成' }] } } }))
      }
      const pending = run(build(), 'peer_send', { peer: 'hermes-cc2', text: '跑个部署' })
      await vi.advanceTimersByTimeAsync(5 * POLL_MS)
      const result = await pending
      expect(result.isError).toBeFalsy()
      expect(view(result)).toMatchObject({ peer: 'hermes-cc2', state: 'completed', text: '部署完成', taskId: 'task-h7', elapsedMs: 3 * POLL_MS })
      // Every poll quotes the task id, on the same endpoint, as a JSON-RPC tasks/get.
      const pollsSent = calls.map(bodyOf).filter(body => body.method === 'tasks/get') as { params: { id: string } }[]
      expect(pollsSent).toHaveLength(3)
      for (const poll of pollsSent) expect(poll.params.id).toBe('task-h7')
      expect(log.mock.calls.filter(([message]) => message === 'peer send')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns state "timeout" with the taskId when the task is still working at the deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    try {
      responder = () => jsonResponse(rpcTask({ id: 'task-h9', status: { state: 'TASK_STATE_WORKING' } }))
      const pending = run(build(), 'peer_send', { peer: 'hermes-cc2', text: '慢任务', timeoutSec: 1 })
      await vi.advanceTimersByTimeAsync(10 * POLL_MS)
      const result = await pending
      expect(result.isError).toBeFalsy()
      const outcome = view(result)
      expect(outcome.state).toBe('timeout')
      expect(outcome.taskId).toBe('task-h9')
      expect(String(outcome.text)).toContain('仍在执行')
      expect(outcome.elapsedMs).toBeGreaterThanOrEqual(1_000)
      expect(log.mock.calls.some(([message]) => message === 'peer timeout')).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails fast on an unknown peer or a missing token without sending any request', async () => {
    responder = vi.fn(() => jsonResponse({}))
    const extension = build({ hermesToken: '', cowToken: '' })
    const unknown = await run(extension, 'peer_send', { peer: 'hal-9000', text: 'hi' })
    expect(unknown.isError).toBe(true)
    expect(unknown.output![0]!.text).toContain('未知 peer "hal-9000"')
    const noToken = await run(extension, 'peer_send', { peer: 'hermes-cc2', text: 'hi' })
    expect(noToken.isError).toBe(true)
    expect(noToken.output![0]!.text).toContain('未配置访问令牌')
    expect(noToken.output![0]!.text).toContain('SUP_PEER_HERMES_TOKEN')
    expect(noToken.output![0]!.text).not.toContain('hermes-secret')
    const cowNoToken = await run(extension, 'peer_send', { peer: 'cowagent-deb02', text: 'hi' })
    expect(cowNoToken.isError).toBe(true)
    expect(cowNoToken.output![0]!.text).toContain('SUP_PEER_COW_TOKEN')
    expect(responder).not.toHaveBeenCalled()
    expect(calls).toHaveLength(0)
  })

  it('retries a network failure exactly once, then returns error text and logs it once', async () => {
    responder = () => Promise.reject(new TypeError('fetch failed'))
    const extension = build()
    const result = await run(extension, 'peer_send', { peer: 'cowagent-deb02', text: 'hi' })
    expect(result.isError).toBe(true)
    expect(result.output![0]!.text).toContain('发送到 peer "cowagent-deb02" 失败')
    expect(result.output![0]!.text).toContain('fetch failed')
    expect(result.output![0]!.text).not.toContain('cow-secret')
    expect(calls).toHaveLength(2) // one attempt plus its single retry
    expect(log.mock.calls.filter(([message]) => message === 'peer send failed')).toHaveLength(1)
  })
})

describe('the runtime switch and the worker brief', () => {
  const runtimeWith = (env: Record<string, string> = {}): PiSuperagentRuntime => {
    const cfg = loadConfig({
      SUP_STATE_DIR: join(directory, 'state'),
      SUP_WORK_DIR: join(directory, 'work'),
      SUP_HARNESS_DIR: join(directory, 'harness'),
      SUP_EVAL_MODE: 'off',
      ...env,
    })
    return new PiSuperagentRuntime(cfg, { channel: new MemoryChannel(), log: () => {} })
  }

  it('installs the peer tools and the「你的同伴」brief section when SUP_PEERS=on', async () => {
    const runtime = runtimeWith({ SUP_PEERS: 'on', SUP_PEER_HERMES_TOKEN: 't1', SUP_PEER_COW_TOKEN: 't2' })
    const names = runtime.registry.snapshot().tools().map(({ tool }) => tool.name)
    for (const name of PEERS_TOOLS) expect(names).toContain(name)
    expect(runtime.peers).toBeDefined()
    expect(runtime.plugin.workerInstructions).toContain('## 你的同伴')
    expect(runtime.plugin.workerInstructions).toContain('hermes-cc2')
    expect(runtime.plugin.workerInstructions).not.toContain('## 你的记忆')
    runtime.peers!.stop()
    await runtime.stop()
  })

  it('adds the「你的记忆」brief section only when SUP_OPENVIKING=on', async () => {
    const withMemory = runtimeWith({ SUP_OPENVIKING: 'on', SUP_OPENVIKING_API_KEY: 'k' })
    expect(withMemory.plugin.workerInstructions).toContain('## 你的记忆')
    expect(withMemory.plugin.workerInstructions).toContain('viking://user/default/memories/events/')
    expect(withMemory.plugin.workerInstructions).not.toContain('## 你的同伴')
    await withMemory.stop()

    const neither = runtimeWith()
    expect(neither.plugin.workerInstructions).not.toContain('## 你的同伴')
    expect(neither.plugin.workerInstructions).not.toContain('## 你的记忆')
    expect(neither.peers).toBeUndefined()
    const names = neither.registry.snapshot().tools().map(({ tool }) => tool.name)
    expect(names.filter(name => name.startsWith('peer_'))).toEqual([])
    await neither.stop()
  })

  it('defaults the peers section off with the builtin URLs, honoring only URL/token/timeout overrides', () => {
    const off = loadConfig({ SUP_STATE_DIR: directory, SUP_WORK_DIR: directory, SUP_HARNESS_DIR: directory })
    expect(off.peers).toEqual({
      enabled: false,
      hermesUrl: 'http://cc2.pig-bowfin.ts.net:18801/',
      hermesToken: '',
      cowUrl: 'http://deb02.pig-bowfin.ts.net:18789/a2a/v1',
      cowToken: '',
      timeoutMs: 300_000,
    })
    const over = loadConfig({
      SUP_STATE_DIR: directory,
      SUP_WORK_DIR: directory,
      SUP_HARNESS_DIR: directory,
      SUP_PEERS: 'on',
      SUP_PEER_HERMES_URL: 'http://127.0.0.1:19001/',
      SUP_PEER_HERMES_TOKEN: 'ht',
      SUP_PEER_COW_TOKEN: 'ct',
      SUP_PEER_TIMEOUT_MS: '999999',
    })
    expect(over.peers.enabled).toBe(true)
    expect(over.peers.hermesUrl).toBe('http://127.0.0.1:19001/')
    expect(over.peers.cowUrl).toBe('http://deb02.pig-bowfin.ts.net:18789/a2a/v1')
    // The configured budget is capped like the caller-facing timeoutSec: 900s at most.
    expect(over.peers.timeoutMs).toBe(900_000)
  })
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})
