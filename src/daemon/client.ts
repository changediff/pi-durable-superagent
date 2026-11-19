/**
 * Outbound-only device daemon loop.
 *
 * The daemon dials the cloud: it registers, heartbeats to keep its lease and the leases of its
 * running assignments alive, polls for work, executes locally and reports a result. It never opens
 * an inbound port. All I/O goes through an injected transport, so the loop is testable without a
 * network or real timers.
 */
import type {
  Assignment,
  DaemonResult,
  DaemonResultStatus,
  HeartbeatRequest,
  HeartbeatResponse,
  RegisterRequest,
  RegisterResponse,
} from './protocol.ts'

const STATUSES: readonly DaemonResultStatus[] = ['done', 'failed', 'blocked']

/** The four cloud calls; a production implementation uses `fetch`, tests inject a fake. */
export interface DaemonTransport {
  register(request: RegisterRequest): Promise<RegisterResponse>
  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse>
  /** Resolves `null` when the cloud answers `204` (nothing queued). */
  poll(): Promise<Assignment | null>
  result(result: DaemonResult): Promise<unknown>
}

export interface DeviceDaemonOptions {
  deviceId: string
  label: string
  model: string
  /** Requested concurrency; the cloud's answer wins. */
  slots?: number
  workdirs?: string[]
  transport: DaemonTransport
  /** Runs one assignment locally; may reject, which is reported as `failed`. */
  execute(assignment: Assignment): Promise<DaemonResult>
  clock?: () => number
  log?: (message: string, detail?: unknown) => void
  pollIntervalMs?: number
  heartbeatIntervalMs?: number
  /** How long `stop()` waits for assignments already executing. */
  drainMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
  /** Injectable sleep; the default uses timers that `stop()` can clear. */
  sleep?: (ms: number) => Promise<void>
  /** Run a single register/heartbeat/poll/execute/result pass and return. */
  once?: boolean
}

export class DeviceDaemon {
  private readonly transport: DaemonTransport
  private readonly execute: (assignment: Assignment) => Promise<DaemonResult>
  private readonly clock: () => number
  private readonly log: (message: string, detail?: unknown) => void
  private readonly pollIntervalMs: number
  private readonly heartbeatIntervalMs: number
  private readonly drainMs: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly requestedSlots: number
  private readonly workdirs: string[] | undefined
  private readonly once: boolean
  private readonly injectedSleep: ((ms: number) => Promise<void>) | undefined

  /** Assignment ID -> in-flight task. Never exceeds `capacity`. */
  private readonly running = new Map<string, Promise<void>>()
  private readonly wakeups = new Set<() => void>()
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private readonly finished: Promise<void>
  private finish!: () => void
  private started = false
  private stopping = false
  private capacity: number
  private readonly options: DeviceDaemonOptions

  constructor(options: DeviceDaemonOptions) {
    this.options = options
    this.transport = options.transport
    this.execute = options.execute
    this.clock = options.clock ?? (() => Date.now())
    this.log = options.log ?? (() => {})
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 1_000)
    this.heartbeatIntervalMs = Math.max(1, options.heartbeatIntervalMs ?? 20_000)
    this.drainMs = Math.max(0, options.drainMs ?? 30_000)
    this.retryBaseMs = Math.max(1, options.retryBaseMs ?? 1_000)
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 30_000)
    this.requestedSlots = this.clampSlots(options.slots)
    this.workdirs = options.workdirs
    this.once = options.once ?? false
    this.injectedSleep = options.sleep
    // Until registration answers, assume the requested capacity.
    this.capacity = this.requestedSlots
    this.finished = new Promise(resolve => { this.finish = resolve })
  }

  readonly deviceId = (): string => this.options.deviceId

  /**
   * Register, then either run one pass (`once`) or loop until `stop()`.
   * Transport failures are logged and retried with exponential backoff; they never reject.
   */
  async run(): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      if (this.stopping) return
      if (this.once) await this.runOnce()
      else await this.runLoop()
    } catch (error) {
      // A bug in the loop must not tear down the process; transport errors are handled per call.
      this.log('daemon loop stopped on unexpected error', this.summarize(error))
    } finally {
      await this.drain()
      this.finish()
    }
  }

  /**
   * Stop after the assignments already executing finish (bounded by `drainMs`).
   * Wakes any in-flight backoff immediately.
   */
  async stop(): Promise<void> {
    if (this.stopping) {
      await this.finished
      return
    }
    this.stopping = true
    for (const wake of [...this.wakeups]) wake()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    if (!this.started) this.finish()
    await this.finished
  }

  private async runOnce(): Promise<void> {
    let registration: RegisterResponse
    try {
      registration = await this.transport.register(this.registerRequest())
    } catch (error) {
      this.log('daemon register failed', this.summarize(error))
      return
    }
    this.applyRegistration(registration)
    if (this.stopping) return

    try {
      await this.transport.heartbeat({ deviceId: this.options.deviceId, running: [] })
    } catch (error) {
      this.log('daemon heartbeat failed', this.summarize(error))
    }
    if (this.stopping) return

    let assignment: Assignment | null
    try {
      assignment = (await this.transport.poll()) ?? null
    } catch (error) {
      this.log('daemon poll failed', this.summarize(error))
      return
    }
    if (assignment) await this.executeAndReport(assignment)
  }

  private async runLoop(): Promise<void> {
    let failures = 0
    // Register first; a device that cannot register has no lease and no work.
    for (;;) {
      if (this.stopping) return
      try {
        const registration = await this.transport.register(this.registerRequest())
        this.applyRegistration(registration)
        break
      } catch (error) {
        failures += 1
        const delay = this.backoff(failures)
        this.log('daemon register failed; backing off', { delay, error: this.summarize(error) })
        await this.sleepInterruptible(delay)
      }
    }
    failures = 0
    let nextHeartbeat = 0

    while (!this.stopping) {
      try {
        if (this.clock() >= nextHeartbeat) {
          await this.transport.heartbeat({
            deviceId: this.options.deviceId,
            running: [...this.running.keys()],
          })
          nextHeartbeat = this.clock() + this.heartbeatIntervalMs
        }
        if (this.running.size < this.capacity) {
          const assignment = (await this.transport.poll()) ?? null
          // A completed call means the network is healthy again.
          failures = 0
          if (assignment) {
            this.startAssignment(assignment)
            continue
          }
        }
      } catch (error) {
        failures += 1
        const delay = this.backoff(failures)
        this.log('daemon transport error; backing off', { delay, error: this.summarize(error) })
        await this.sleepInterruptible(delay)
        continue
      }
      // Poll returned nothing: wait one interval, waking early for the next heartbeat.
      const untilHeartbeat = nextHeartbeat - this.clock()
      await this.sleepInterruptible(Math.max(0, Math.min(this.pollIntervalMs, untilHeartbeat)))
    }
  }

  private startAssignment(assignment: Assignment): void {
    if (this.running.has(assignment.assignmentId)) return
    const task = this.executeAndReport(assignment)
      .catch(error => this.log('daemon assignment failed unexpectedly', this.summarize(error)))
      .finally(() => { this.running.delete(assignment.assignmentId) })
    this.running.set(assignment.assignmentId, task)
  }

  private async executeAndReport(assignment: Assignment): Promise<void> {
    let result: DaemonResult
    try {
      result = await this.execute(assignment)
    } catch (error) {
      const summary = this.summarize(error)
      this.log('daemon execute failed', { assignmentId: assignment.assignmentId, error: summary })
      result = { assignmentId: assignment.assignmentId, status: 'failed', text: summary }
    }
    await this.report(this.normalize(assignment, result))
  }

  /** Deliver a result, retrying network failures (the server ignores duplicates). */
  private async report(result: DaemonResult): Promise<void> {
    let failures = 0
    for (;;) {
      try {
        await this.transport.result(result)
        return
      } catch (error) {
        failures += 1
        const delay = this.backoff(failures)
        this.log('daemon result delivery failed; retrying', {
          assignmentId: result.assignmentId,
          delay,
          error: this.summarize(error),
        })
        if (this.stopping) return
        await this.sleepInterruptible(delay)
        if (this.stopping) return
      }
    }
  }

  /** Force the protocol's invariants: server-issued ID and one of the three statuses. */
  private normalize(assignment: Assignment, result: DaemonResult | undefined): DaemonResult {
    const status = (result as DaemonResult | undefined)?.status
    if (!status || !STATUSES.includes(status)) {
      return {
        assignmentId: assignment.assignmentId,
        status: 'failed',
        text: `invalid result status: ${String(status)}`,
      }
    }
    const text = typeof result?.text === 'string' ? result.text : ''
    return {
      assignmentId: assignment.assignmentId,
      status,
      text,
      ...(result?.usage ? { usage: result.usage } : {}),
    }
  }

  private applyRegistration(registration: RegisterResponse): void {
    this.capacity = this.clampSlots(registration.slots ?? this.requestedSlots)
    if (this.capacity !== this.requestedSlots) {
      this.log('daemon capacity set by cloud', { requested: this.requestedSlots, granted: this.capacity })
    }
  }

  private registerRequest(): RegisterRequest {
    return {
      deviceId: this.options.deviceId,
      label: this.options.label,
      model: this.options.model,
      ...(this.requestedSlots > 1 ? { slots: this.requestedSlots } : {}),
      ...(this.workdirs?.length ? { workdirs: this.workdirs } : {}),
    }
  }

  private clampSlots(requested: number | undefined): number {
    if (requested === undefined || !Number.isFinite(requested)) return 1
    return Math.max(1, Math.min(4, Math.trunc(requested)))
  }

  private backoff(failures: number): number {
    return Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** Math.max(0, failures - 1))
  }

  /** Sleep that `stop()` can interrupt; the underlying timer is cleared on stop. */
  private async sleepInterruptible(ms: number): Promise<void> {
    if (this.stopping) return
    await new Promise<void>(resolve => {
      let settled = false
      const done = (): void => {
        if (settled) return
        settled = true
        this.wakeups.delete(done)
        resolve()
      }
      this.wakeups.add(done)
      void this.sleep(ms).then(done, done)
    })
  }

  private sleep(ms: number): Promise<void> {
    if (this.injectedSleep) return this.injectedSleep(ms)
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.timers.delete(timer)
        resolve()
      }, ms)
      this.timers.add(timer)
    })
  }

  private async drain(): Promise<void> {
    const inFlight = [...this.running.values()]
    if (!inFlight.length) return
    await Promise.race([
      Promise.allSettled(inFlight),
      new Promise<void>(resolve => {
        const timer = setTimeout(resolve, this.drainMs)
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
    if (this.running.size) {
      this.log('daemon stopped with assignments still running', { running: [...this.running.keys()] })
    }
  }

  private summarize(error: unknown): string {
    const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return text.length > 2_000 ? `${text.slice(0, 1_997)}...` : text
  }
}
