/**
 * The first end-to-end wire of the BYOM daemon: HTTP handlers on one side, the worker `device`
 * tool on the other, both over the same in-process broker. Zero network and zero real time — the
 * handler is called with plain request objects and the clock/sleep are injected.
 */
import { describe, expect, it } from 'vitest'
import { DeviceBroker } from '../src/daemon/broker.ts'
import { DaemonHttpApi, type DaemonHttpResponse, type DaemonHttpRequest } from '../src/daemon/http.ts'
import type { Assignment } from '../src/daemon/protocol.ts'
import { createDeviceTool } from '../src/plugin/device.ts'

const TOKEN = 'daemon-secret'
const AUTH = `Bearer ${TOKEN}`
const START = 1_000_000
const LEASE_MS = 60_000

interface LogEntry { message: string; detail?: unknown }

/** A broker plus its HTTP surface, sharing one fake clock and an advancing sleep. */
function makeWire() {
  const clock = { now: START }
  const logs: LogEntry[] = []
  const broker = new DeviceBroker({ now: () => clock.now, leaseMs: LEASE_MS })
  const api = new DaemonHttpApi({
    registry: broker.registry,
    token: TOKEN,
    log: (message, detail) => { logs.push({ message, detail }) },
    now: () => clock.now,
    // An idle long-poll advances the fake clock instead of waiting in real time.
    sleep: async ms => { clock.now += ms },
    pollIntervalMs: 100,
    maxWaitMs: 1_000,
  })
  return { broker, api, clock, logs }
}

const post = (api: DaemonHttpApi, path: string, body: unknown, authorization = AUTH): Promise<DaemonHttpResponse> =>
  api.handle({ method: 'POST', path, authorization, body })

const register = (api: DaemonHttpApi, deviceId = 'dev-1', slots = 1): Promise<DaemonHttpResponse> =>
  post(api, '/daemon/register', { deviceId, label: 'laptop', model: 'local-model', slots })

const lease = (api: DaemonHttpApi, deviceId = 'dev-1'): Promise<DaemonHttpResponse> =>
  post(api, '/daemon/lease', { deviceId, waitSeconds: 0 })

const result = (api: DaemonHttpApi, assignmentId: string, status: string, text: string): Promise<DaemonHttpResponse> =>
  post(api, '/daemon/result', { assignmentId, status, text })

const outputText = (value: unknown): string => {
  const output = (value as { output?: { text?: string }[] })?.output
  return output?.map(part => part.text ?? '').join('') ?? ''
}

/** Reject after `ms` real milliseconds, so a hung tool fails the test instead of hanging it. */
function within<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

describe('daemon HTTP wire', () => {
  it('runs register -> heartbeat -> lease -> complete, and exposes the result to the waiting tool', async () => {
    const { broker, api, clock, logs } = makeWire()

    const registered = await register(api)
    expect(registered.status).toBe(200)
    expect(registered.body).toMatchObject({
      deviceId: 'dev-1',
      slots: 1,
      leaseMs: LEASE_MS,
      pollPath: '/daemon/lease',
    })

    const heartbeat = await post(api, '/daemon/heartbeat', { deviceId: 'dev-1' })
    expect(heartbeat.body).toMatchObject({ online: true })

    const { ticketId } = broker.enqueue({ prompt: 'say hi', workdir: '/work' })
    const leased = await lease(api)
    expect(leased.status).toBe(200)
    const assignment = leased.body as Assignment
    expect(assignment).toMatchObject({ ticketId, brief: 'say hi', workdir: '/work' })
    expect(assignment.deadlineAt).toBe(new Date(clock.now + LEASE_MS).toISOString())

    const completed = await result(api, assignment.assignmentId, 'done', 'hello from the device')
    expect(completed.status).toBe(200)
    expect(completed.body).toMatchObject({ ok: true, duplicate: false, status: 'done' })

    const outcome = await broker.wait(ticketId, { timeoutMs: 1_000, now: () => clock.now })
    expect(outcome).toEqual({
      kind: 'result',
      result: { assignmentId: assignment.assignmentId, status: 'done', text: 'hello from the device' },
    })

    expect(logs.map(entry => entry.message)).toEqual(expect.arrayContaining([
      'daemon registered',
      'daemon heartbeat',
      'daemon lease handoff',
      'daemon result received',
    ]))
  })

  it('returns 204 from an idle long-poll instead of holding forever', async () => {
    const { api, clock } = makeWire()
    await register(api)

    const started = clock.now
    const idle = await post(api, '/daemon/lease', { deviceId: 'dev-1', waitSeconds: 5 })
    expect(idle.status).toBe(204)
    expect(idle.body).toBeUndefined()
    // Capped by maxWaitMs=1000 in the fake wire, not the requested 5s.
    expect(clock.now - started).toBe(1_000)
  })

  it('acknowledges a repeated result as duplicate without changing the recorded status', async () => {
    const { broker, api } = makeWire()
    await register(api)
    broker.enqueue({ prompt: 'work', workdir: '/work' })
    const assignment = (await lease(api)).body as Assignment

    expect((await result(api, assignment.assignmentId, 'done', 'first')).body)
      .toMatchObject({ ok: true, duplicate: false, status: 'done' })
    expect((await result(api, assignment.assignmentId, 'failed', 'second')).body)
      .toMatchObject({ ok: true, duplicate: true, status: 'done' })
  })

  it('rejects every /daemon request without the bearer token', async () => {
    const { api } = makeWire()
    const calls: DaemonHttpRequest[] = [
      { method: 'POST', path: '/daemon/register', body: { deviceId: 'dev-1' } },
      { method: 'POST', path: '/daemon/heartbeat', body: { deviceId: 'dev-1' } },
      { method: 'POST', path: '/daemon/lease', body: { deviceId: 'dev-1' } },
      { method: 'POST', path: '/daemon/result', body: { assignmentId: 'a', status: 'done', text: '' } },
    ]
    for (const call of calls) {
      expect((await api.handle(call)).status).toBe(401)
      expect((await api.handle({ ...call, authorization: 'Bearer wrong' })).status).toBe(401)
    }
  })
})

describe('device tool', () => {
  it('fails immediately with an error text when no device is online', async () => {
    const broker = new DeviceBroker()
    let slept = false
    const tool = createDeviceTool({
      broker,
      workdir: '/work',
      log: () => {},
      now: () => START,
      sleep: async () => { slept = true },
    })

    const started = Date.now()
    const outcome = await within(tool.execute({ prompt: 'do it' }, {} as never, {} as never), 500)
    expect((outcome as { isError?: boolean }).isError).toBe(true)
    expect(outputText(outcome)).toContain('没有在线设备')
    expect(slept).toBe(false)
    expect(Date.now() - started).toBeLessThan(400)
  })

  it('returns the device reason when the assignment reports failed', async () => {
    const { broker, api, clock } = makeWire()
    await register(api)
    let leased = false
    const tool = createDeviceTool({
      broker,
      workdir: '/work',
      log: () => {},
      now: () => clock.now,
      sleep: async ms => {
        if (!leased) {
          leased = true
          const assignment = (await lease(api)).body as Assignment
          await result(api, assignment.assignmentId, 'failed', '本地模型罢工了')
        } else {
          clock.now += ms
        }
      },
      pollMs: 100,
    })

    const outcome = await within(tool.execute({ prompt: 'do it', timeoutSec: 10 }, {} as never, {} as never))
    expect((outcome as { isError?: boolean }).isError).toBe(true)
    expect(outputText(outcome)).toContain('device failed: 本地模型罢工了')
  })

  it('keeps the assignmentId in the timeout text and leaves the leased work running', async () => {
    const { broker, api, clock } = makeWire()
    await register(api)
    let assignmentId: string | undefined
    let leaseCount = 0
    const tool = createDeviceTool({
      broker,
      workdir: '/work',
      log: () => {},
      now: () => clock.now,
      sleep: async ms => {
        if (!assignmentId) {
          leaseCount += 1
          const assignment = (await lease(api)).body as Assignment
          assignmentId = assignment.assignmentId
        }
        clock.now += ms
      },
      pollMs: 250,
    })

    const outcome = await within(tool.execute({ prompt: 'slow work', timeoutSec: 1 }, {} as never, {} as never))
    const text = outputText(outcome)
    expect((outcome as { isError?: boolean }).isError).toBe(true)
    expect(text).toContain('已超时，任务仍在设备上执行')
    expect(text).toContain(`assignmentId: ${assignmentId}`)
    expect(leaseCount).toBe(1)
    // The lease was not reclaimed by the tool: the assignment is still live in the registry.
    expect(broker.registry.deviceOf(assignmentId!)).toBe('dev-1')
  })
})
