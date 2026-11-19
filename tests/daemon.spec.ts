/**
 * Device daemon (BYOM) protocol and lease semantics. Zero network and zero real time: the registry
 * gets a fake clock, and the client gets a fake transport plus an injected sleep.
 */
import { describe, expect, it } from 'vitest'
import { DeviceDaemon, type DaemonTransport, type DeviceDaemonOptions } from '../src/daemon/client.ts'
import { DaemonRegistry, type QueuedWork } from '../src/daemon/registry.ts'
import type {
  Assignment,
  DaemonResult,
  HeartbeatRequest,
  HeartbeatResponse,
  RegisterRequest,
  RegisterResponse,
} from '../src/daemon/protocol.ts'

const MAKE_REGISTRY_NOW = 1_000_000
const LEASE_MS = 60_000

const work = (ticketId: string): QueuedWork => ({ ticketId, brief: `brief for ${ticketId}`, workdir: '/work' })

/** Registry with a mutable queue and a manually advanced clock. */
function makeRegistry(queue: QueuedWork[] = [], now = MAKE_REGISTRY_NOW) {
  const clock = { now }
  const registry = new DaemonRegistry({
    queue: () => queue,
    now: () => clock.now,
    leaseMs: LEASE_MS,
  })
  return {
    registry,
    clock,
    advance: (ms: number) => { clock.now += ms },
    push: (item: QueuedWork) => queue.push(item),
  }
}

interface TransportHooks {
  register?: (request: RegisterRequest) => Promise<RegisterResponse>
  heartbeat?: (request: HeartbeatRequest) => Promise<HeartbeatResponse>
  poll?: () => Promise<Assignment | null>
  result?: (result: DaemonResult) => Promise<unknown>
}

/** A fake transport that records every call and every payload, preserving call order. */
function makeTransport(hooks: TransportHooks = {}) {
  const calls: string[] = []
  const registers: RegisterRequest[] = []
  const heartbeats: HeartbeatRequest[] = []
  const results: DaemonResult[] = []
  const transport: DaemonTransport = {
    register: async request => {
      calls.push('register')
      registers.push(request)
      return hooks.register
        ? hooks.register(request)
        : { deviceId: request.deviceId, leaseMs: LEASE_MS, pollPath: '/daemon/poll', slots: request.slots ?? 1 }
    },
    heartbeat: async request => {
      calls.push('heartbeat')
      heartbeats.push(request)
      return hooks.heartbeat ? hooks.heartbeat(request) : { online: true, running: request.running ?? [] }
    },
    poll: async () => {
      calls.push('poll')
      return hooks.poll ? hooks.poll() : null
    },
    result: async result => {
      calls.push('result')
      results.push(result)
      return hooks.result ? hooks.result(result) : undefined
    },
  }
  return { transport, calls, registers, heartbeats, results }
}

const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({
  assignmentId: 'assignment-1',
  ticketId: 'ticket-1',
  brief: 'Fix the failing test.',
  workdir: '/work/repo',
  deadlineAt: new Date(MAKE_REGISTRY_NOW + LEASE_MS).toISOString(),
  ...overrides,
})

function makeDaemon(transport: DaemonTransport, overrides: Partial<DeviceDaemonOptions> = {}): DeviceDaemon {
  return new DeviceDaemon({
    deviceId: 'dev-1',
    label: 'laptop',
    model: 'local-model',
    slots: 1,
    transport,
    execute: async item => ({ assignmentId: item.assignmentId, status: 'done', text: 'ok' }),
    clock: () => 0,
    log: () => {},
    sleep: async () => {},
    pollIntervalMs: 1_000,
    heartbeatIntervalMs: 20_000,
    retryBaseMs: 1_000,
    retryMaxMs: 30_000,
    drainMs: 100,
    ...overrides,
  })
}

/** Reject after `ms` real milliseconds, so a hung daemon fails the test instead of hanging it. */
function within<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => { if (timer) clearTimeout(timer) })
}

describe('DaemonRegistry', () => {
  it('registers a device, returns leaseMs/pollPath and caps slots at 4', () => {
    const { registry } = makeRegistry()

    const capped = registry.register({ deviceId: 'dev-a', label: 'laptop', model: 'm', slots: 9 })
    expect(capped).toEqual({ deviceId: 'dev-a', leaseMs: LEASE_MS, pollPath: '/daemon/poll', slots: 4 })

    const byDefault = registry.register({ deviceId: 'dev-b', label: 'desktop', model: 'm' })
    expect(byDefault.slots).toBe(1)
    expect(registry.stats()).toEqual({ devices: 2, leased: 0, queued: 0, expired: 0 })
  })

  it('leases one assignment per slot and never hands out the same queue entry twice', () => {
    const { registry, clock } = makeRegistry([work('ticket-1'), work('ticket-2')])
    registry.register({ deviceId: 'dev-a', label: 'laptop', model: 'm', slots: 1 })

    const first = registry.lease('dev-a')
    expect(first).toBeDefined()
    expect(first).toMatchObject({
      ticketId: 'ticket-1',
      brief: 'brief for ticket-1',
      workdir: '/work',
      deadlineAt: new Date(clock.now + LEASE_MS).toISOString(),
    })
    // slots=1: the free slot is gone even though ticket-2 is still queued.
    expect(registry.lease('dev-a')).toBeUndefined()
    expect(registry.stats()).toMatchObject({ devices: 1, leased: 1, queued: 1, expired: 0 })
  })

  it('reclaims an expired lease and lets another device take the same ticket', () => {
    const { registry, advance } = makeRegistry([work('ticket-1')])
    registry.register({ deviceId: 'dev-a', label: 'laptop', model: 'm' })
    const first = registry.lease('dev-a')!

    advance(LEASE_MS)
    expect(registry.expire()).toEqual([first.assignmentId])
    expect(registry.online('dev-a')).toBe(false)

    registry.register({ deviceId: 'dev-b', label: 'desktop', model: 'm' })
    const second = registry.lease('dev-b')
    expect(second).toMatchObject({ ticketId: 'ticket-1' })
    expect(second!.assignmentId).not.toBe(first.assignmentId)
    expect(registry.stats()).toEqual({ devices: 2, leased: 1, queued: 0, expired: 1 })
  })

  it('completes once, then acknowledges a repeated assignmentId as a duplicate without changing state', () => {
    const { registry, advance } = makeRegistry([work('ticket-1')])
    registry.register({ deviceId: 'dev-a', label: 'laptop', model: 'm' })
    const leased = registry.lease('dev-a')!

    const result: DaemonResult = { assignmentId: leased.assignmentId, status: 'done', text: 'shipped' }
    expect(registry.complete('dev-a', result)).toEqual({
      ok: true,
      duplicate: false,
      assignmentId: leased.assignmentId,
      status: 'done',
    })
    expect(registry.stats().leased).toBe(0)

    const duplicate = registry.complete('dev-a', { ...result, status: 'failed', text: 'retry' })
    expect(duplicate).toEqual({ ok: true, duplicate: true, assignmentId: leased.assignmentId, status: 'done' })

    // A completed assignment is never reclaimed, and its state did not change.
    advance(LEASE_MS * 2)
    expect(registry.expire()).toEqual([])
    expect(registry.stats().leased).toBe(0)
  })

  it('reports an error for a result that was never leased instead of throwing', () => {
    const { registry } = makeRegistry()
    registry.register({ deviceId: 'dev-a', label: 'laptop', model: 'm' })

    expect(() => registry.complete('dev-a', { assignmentId: 'ghost', status: 'done', text: '' })).not.toThrow()
    expect(registry.complete('dev-a', { assignmentId: 'ghost', status: 'done', text: '' })).toEqual({
      ok: false,
      error: 'unknown assignment ghost',
    })
    expect(registry.complete('dev-unknown', { assignmentId: 'ghost', status: 'done', text: '' })).toEqual({
      ok: false,
      error: 'unknown device dev-unknown',
    })
  })

  it('stays online only while heartbeats renew the lease', () => {
    const { registry, advance } = makeRegistry()
    registry.register({ deviceId: 'dev-a', label: 'laptop', model: 'm' })

    expect(registry.online('dev-a')).toBe(true)
    advance(LEASE_MS - 1)
    expect(registry.online('dev-a')).toBe(true)
    advance(1)
    expect(registry.online('dev-a')).toBe(false)

    expect(registry.heartbeat('dev-a', ['assignment-1'])).toEqual({ online: true, running: ['assignment-1'] })
    expect(registry.online('dev-a')).toBe(true)
    advance(LEASE_MS - 1)
    expect(registry.online('dev-a')).toBe(true)
    advance(1)
    expect(registry.online('dev-a')).toBe(false)

    expect(registry.heartbeat('dev-unknown')).toEqual({ online: false, error: 'unknown device dev-unknown' })
  })

  it('renews assignment leases on heartbeat so work in progress is not reclaimed', () => {
    const { registry, advance } = makeRegistry([work('ticket-1')])
    registry.register({ deviceId: 'dev-a', label: 'laptop', model: 'm' })
    const leased = registry.lease('dev-a')!

    advance(LEASE_MS - 1)
    registry.heartbeat('dev-a', [leased.assignmentId])
    advance(LEASE_MS - 1)
    expect(registry.expire()).toEqual([])
    expect(registry.complete('dev-a', { assignmentId: leased.assignmentId, status: 'done', text: 'ok' }).ok).toBe(true)
  })
})

describe('DeviceDaemon', () => {
  it('runs register -> heartbeat -> poll -> execute -> result', async () => {
    const leased = assignment()
    const fake = makeTransport({ poll: async () => leased })
    const daemon = makeDaemon(fake.transport, {
      once: true,
      execute: async item => {
        fake.calls.push('execute')
        return {
          assignmentId: item.assignmentId,
          status: 'done',
          text: 'finished',
          usage: { inputTokens: 10, outputTokens: 20 },
        }
      },
    })

    await within(daemon.run())

    expect(fake.calls).toEqual(['register', 'heartbeat', 'poll', 'execute', 'result'])
    expect(fake.registers[0]).toMatchObject({ deviceId: 'dev-1', label: 'laptop', model: 'local-model' })
    expect(fake.heartbeats[0]).toMatchObject({ deviceId: 'dev-1' })
    expect(fake.results[0]).toEqual({
      assignmentId: leased.assignmentId,
      status: 'done',
      text: 'finished',
      usage: { inputTokens: 10, outputTokens: 20 },
    })
  })

  it('turns an execute exception into a failed result and keeps polling', async () => {
    let polls = 0
    let daemon!: DeviceDaemon
    const fake = makeTransport({
      poll: async () => {
        polls += 1
        if (polls === 1) return assignment()
        // The loop must survive the exception and poll again; stop on the third pass.
        if (polls >= 3) void daemon.stop()
        return null
      },
    })
    daemon = makeDaemon(fake.transport, {
      execute: async () => { throw new Error('local model exploded') },
    })

    await within(daemon.run())

    expect(polls).toBeGreaterThanOrEqual(3)
    expect(fake.results).toHaveLength(1)
    expect(fake.results[0]).toMatchObject({ assignmentId: 'assignment-1', status: 'failed' })
    expect(fake.results[0]!.text).toContain('local model exploded')
    expect(fake.calls.filter(call => call === 'poll')).toHaveLength(polls)
  })

  it('backs off 1s -> 2s -> 4s and stop() ends the loop', async () => {
    const delays: number[] = []
    let daemon!: DeviceDaemon
    const fake = makeTransport({
      poll: async () => { throw new Error('network down') },
    })
    daemon = makeDaemon(fake.transport, {
      sleep: async ms => {
        delays.push(ms)
        if (delays.length >= 3) void daemon.stop()
      },
    })

    await within(daemon.run())

    expect(delays.slice(0, 3)).toEqual([1_000, 2_000, 4_000])
  })

  it('stop() interrupts an in-flight backoff sleep immediately', async () => {
    let entered!: () => void
    const sleeping = new Promise<void>(resolve => { entered = resolve })
    const fake = makeTransport({
      poll: async () => { throw new Error('offline') },
    })
    const daemon = makeDaemon(fake.transport, {
      // Never resolves on its own; only stop()'s wake-up can release the loop.
      sleep: () => { entered(); return new Promise<void>(() => {}) },
    })

    const running = daemon.run()
    await within(sleeping)
    await within(daemon.stop(), 500)
    await within(running, 500)
    expect(fake.calls.filter(call => call === 'poll')).toHaveLength(1)
  })

  it('--once performs exactly one poll', async () => {
    const fake = makeTransport()
    const daemon = makeDaemon(fake.transport, { once: true })

    await within(daemon.run())

    expect(fake.calls).toEqual(['register', 'heartbeat', 'poll'])
    expect(fake.calls.filter(call => call === 'poll')).toHaveLength(1)
    expect(fake.results).toHaveLength(0)
  })

  it('never runs more than the granted number of assignments at once', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let active = 0
    let peak = 0
    let secondStarted!: () => void
    const bothStarted = new Promise<void>(resolve => { secondStarted = resolve })
    let polls = 0
    let daemon!: DeviceDaemon

    const fake = makeTransport({
      // The cloud grants fewer slots than the daemon asked for; the grant wins.
      register: async request => ({ deviceId: request.deviceId, leaseMs: LEASE_MS, pollPath: '/daemon/poll', slots: 2 }),
      poll: async () => {
        polls += 1
        if (polls <= 4) {
          return assignment({ assignmentId: `assignment-${polls}`, ticketId: `ticket-${polls}` })
        }
        void daemon.stop()
        return null
      },
    })
    daemon = makeDaemon(fake.transport, {
      slots: 4,
      execute: async item => {
        active += 1
        peak = Math.max(peak, active)
        if (active === 2) secondStarted()
        await gate
        active -= 1
        return { assignmentId: item.assignmentId, status: 'done', text: 'ok' }
      },
    })

    const running = daemon.run()
    await within(bothStarted)
    // While two are in flight the scheduler may not poll for a third.
    expect(peak).toBe(2)
    expect(polls).toBe(2)
    release()
    await within(running)
    expect(peak).toBe(2)
    expect(fake.results).toHaveLength(4)
  })
})
