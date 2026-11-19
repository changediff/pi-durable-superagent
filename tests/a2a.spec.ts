/** A2A server channel: agent card, auth, SendMessage round-trip and tasks/get. No models involved. */
import { describe, expect, it, afterEach } from 'vitest'
import { A2AChannel } from '../src/pi/a2a.ts'
import { callPeer } from '../src/pi/a2a-client.ts'
import { loadConfig } from '../src/pi/config.ts'
import type { Config } from '../src/pi/config.ts'
import type { Trigger } from '../src/core/index.ts'

const baseConfig = (env: Record<string, string> = {}): Config => loadConfig({
  SUP_STATE_DIR: '/tmp/sup-a2a-test',
  SUP_A2A: '1',
  SUP_A2A_TOKEN: 'secret-token',
  SUP_A2A_PEERS: JSON.stringify([{ name: 'self', url: 'http://127.0.0.1', token: 'secret-token', timeout: 10 }]),
  ...env,
})

const freePort = async (): Promise<number> => {
  const { createServer } = await import('node:http')
  return await new Promise(resolve => {
    const probe = createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

const started: A2AChannel[] = []

const startChannel = async (env: Record<string, string> = {}): Promise<{ channel: A2AChannel; port: number }> => {
  const port = await freePort()
  const channel = new A2AChannel({ ...baseConfig(env).a2a, port, publicUrl: `http://127.0.0.1:${port}` }, {
    onTrigger: trigger => { void channel.send({ id: `out-${trigger.id}`, channel: trigger.channel!, text: `echo: ${trigger.text}`, kind: 'reply' }) },
    log: () => {},
  })
  await channel.start()
  started.push(channel)
  return { channel, port }
}

afterEach(async () => {
  while (started.length) await started.pop()?.stop()
})

const post = async (port: number, body: unknown, token?: string): Promise<{ status: number; json: any }> => {
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: await response.json() as any }
}

const sendRpc = (text: string, id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'SendMessage',
  params: { message: { role: 'ROLE_USER', messageId: 'm1', contextId: 'ctx-test', parts: [{ kind: 'text', text }] } },
})

describe('a2a server', () => {
  it('serves the agent card', async () => {
    const { port } = await startChannel()
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`)
    expect(response.status).toBe(200)
    expect((await response.json() as any).name).toBe('cc2-pi')
  })

  it('rejects missing bearer token with -32050', async () => {
    const { port } = await startChannel()
    const { json } = await post(port, sendRpc('hi'))
    expect(json.error?.code).toBe(-32050)
  })

  it('round-trips SendMessage: trigger in, completed task out', async () => {
    const seen: Trigger[] = []
    const port = await freePort()
    const cfg = baseConfig()
    const channel = new A2AChannel({ ...cfg.a2a, port }, {
      onTrigger: trigger => {
        seen.push(trigger)
        void channel.send({ id: 'out-1', channel: trigger.channel!, text: 'PONG', kind: 'reply' })
      },
      log: () => {},
    })
    await channel.start()
    started.push(channel)
    const { status, json } = await post(port, sendRpc('只回一行 PONG'), 'secret-token')
    expect(status).toBe(200)
    expect(seen[0]?.source).toBe('a2a')
    expect(seen[0]?.text).toBe('只回一行 PONG')
    const task = json.result.task
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(task.artifacts[0].parts[0].text).toBe('PONG')

    const query = await post(port, { jsonrpc: '2.0', id: 2, method: 'tasks/get', params: { id: task.id } }, 'secret-token')
    expect(query.json.result.task.id).toBe(task.id)
    expect(query.json.result.task.status.state).toBe('TASK_STATE_COMPLETED')
  })

  it('waits for the reply, not the acknowledgement, before completing', async () => {
    const port = await freePort()
    const cfg = baseConfig()
    const channel = new A2AChannel({ ...cfg.a2a, port }, {
      onTrigger: trigger => {
        void channel.send({ id: 'out-ack', channel: trigger.channel!, text: '已受理，正在处理', kind: 'acknowledgement' })
        setTimeout(() => {
          void channel.send({ id: 'out-reply', channel: trigger.channel!, text: 'PONG', kind: 'reply' })
        }, 400)
      },
      log: () => {},
    })
    await channel.start()
    started.push(channel)
    const { status, json } = await post(port, sendRpc('只回一行 PONG'), 'secret-token')
    expect(status).toBe(200)
    const task = json.result.task
    expect(task.status.state).toBe('TASK_STATE_COMPLETED')
    expect(task.artifacts[0].parts[0].text).toBe('PONG')
    expect(task.artifacts[0].parts[0].text).not.toBe('已受理，正在处理')
    expect(task.status.message?.parts[0]?.text).not.toBe('已受理，正在处理')
  })

  it('answers tasks/get with -32001 for unknown ids', async () => {
    const { port } = await startChannel()
    const { json } = await post(port, { jsonrpc: '2.0', id: 3, method: 'tasks/get', params: { id: 'task-nope' } }, 'secret-token')
    expect(json.error?.code).toBe(-32001)
  })

  it('interoperates with the client against the server', async () => {
    const { port } = await startChannel()
    const result = await callPeer({ name: 'self', url: `http://127.0.0.1:${port}`, token: 'secret-token', timeout: 10 }, '只回一行 PONG')
    expect(result.state).toBe('TASK_STATE_COMPLETED')
    expect(result.text).toBe('echo: 只回一行 PONG')
  })
})
