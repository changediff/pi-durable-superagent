/**
 * Tool-level checks for `a2a_send`: the outbound A2A capability exposed as a plugin tool.
 * A fake peer (node:http) speaks just enough JSON-RPC to answer SendMessage, and the tool
 * must return the artifact text — while an unconfigured peer yields readable error text.
 */
import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSuperagentExtension, type SuperagentConfig } from '../src/plugin/index.ts'

const PEER_TEXT = '来自假 peer 的回答：PONG'

let directory: string
let server: Server | undefined
let port = 0

const config = (): SuperagentConfig => ({
  stateDir: join(directory, 'state'),
  workDir: join(directory, 'work'),
  harnessDir: join(directory, 'harness'),
  maxWorkers: 1,
  evalMode: 'auto',
  router: { provider: 'faux', model: 'router-1' },
  worker: { provider: 'faux', model: 'worker-1' },
  channel: { send: async () => 'sent' },
  assessor: { baseUrl: 'http://127.0.0.1:9', apiKeyEnv: 'UNSET_FOR_TEST' },
  allowAll: true,
  log: () => {},
})

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'superagent-a2a-tool-')) })
afterEach(async () => {
  await new Promise<void>(resolve => server ? server.close(() => resolve()) : resolve())
  rmSync(directory, { recursive: true, force: true })
})

/** Start a fake A2A peer that answers SendMessage with one text artifact. */
const startFakePeer = async (): Promise<void> => {
  server = createServer((req, res) => {
    if (req.url?.includes('agent-card')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: `http://127.0.0.1:${port}` }))
      return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const taskId = `task-${randomUUID().slice(0, 8)}`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        jsonrpc: '2.0', id: 1, result: { task: { id: taskId, contextId: 'ctx-1', status: { state: 'TASK_STATE_COMPLETED' }, artifacts: [{ artifactId: 'a1', parts: [{ kind: 'text', text: PEER_TEXT }] }] } },
      }))
    })
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
}

const toolOf = (names: readonly string[], plugin: ReturnType<typeof createSuperagentExtension>) => {
  const tool = plugin.tools!.find(candidate => candidate.name === 'a2a_send')
  expect(names).toContain('a2a_send')
  expect(tool).toBeDefined()
  return tool!
}

describe('the a2a_send tool', () => {
  it('returns the peer answer text from artifacts[0].parts[0].text', async () => {
    await startFakePeer()
    const plugin = createSuperagentExtension({
      ...config(),
      a2a: { enabled: true, peers: [{ name: 'fake', url: `http://127.0.0.1:${port}`, timeout: 5 }] },
    })
    const tool = toolOf(plugin.tools!.map(candidate => candidate.name), plugin)
    const result = await tool.execute({ peer: 'fake', text: 'ping' }, {} as never, {} as never) as { isError?: boolean; output?: { type: string; text: string }[] }
    expect(result.isError).toBeFalsy()
    expect(result.output![0]).toMatchObject({ type: 'text', text: PEER_TEXT })
    await plugin.stop()
  })

  it('returns readable error text for an unknown peer', async () => {
    const plugin = createSuperagentExtension({ ...config(), a2a: { enabled: true, peers: [] } })
    const tool = toolOf(plugin.tools!.map(candidate => candidate.name), plugin)
    const result = await tool.execute({ peer: 'ghost', text: 'ping' }, {} as never, {} as never) as { isError: boolean; output: { text: string }[] }
    expect(result.isError).toBe(true)
    expect(result.output[0]!.text).toContain('unknown peer "ghost"')
    await plugin.stop()
  })

  it('returns readable error text when the peer call fails', async () => {
    const plugin = createSuperagentExtension({
      ...config(),
      a2a: { enabled: true, peers: [{ name: 'dead', url: 'http://127.0.0.1:9', timeout: 1 }] },
    })
    const tool = toolOf(plugin.tools!.map(candidate => candidate.name), plugin)
    const result = await tool.execute({ peer: 'dead', text: 'ping' }, {} as never, {} as never) as { isError: boolean; output: { text: string }[] }
    expect(result.isError).toBe(true)
    expect(result.output[0]!.text).toContain('a2a_send: calling peer "dead" failed')
    await plugin.stop()
  })
})
