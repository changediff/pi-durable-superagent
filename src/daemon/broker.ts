/**
 * The cloud-side work broker between the `device` tool and the lease registry.
 *
 * The tool queues a prompt, a device leases it (receiving a server-issued `assignmentId`) and
 * executes it, and the tool waits for the result the device reports over HTTP. The broker is the
 * piece that connects those two sides inside one process: it owns the queue the registry reads,
 * remembers which assignment belongs to which queued job, and records the result for the waiter.
 *
 * Storage-free, like the registry: a container restart loses queued jobs and in-flight leases, which
 * is acceptable for this cut (the ticket/thread state stays in SQLite; only device work is volatile).
 */
import { DaemonRegistry, type QueuedWork } from './registry.ts'
import type { Assignment, DaemonResult } from './protocol.ts'

export interface DeviceJobRequest {
  prompt: string
  workdir: string
  /** Pin the job to one device id; omitted means any online device may lease it. */
  device?: string
}

interface Job {
  ticketId: string
  request: DeviceJobRequest
  assignmentId?: string
  result?: DaemonResult
}

export interface DeviceBrokerOptions {
  now?: () => number
  leaseMs?: number
  maxSlots?: number
  pollPath?: string
}

export type DeviceWaitOutcome =
  | { kind: 'result'; result: DaemonResult }
  /** `assignmentId` is present once a device leased the job; absent if it timed out unleased. */
  | { kind: 'timeout'; ticketId: string; assignmentId?: string }
  | { kind: 'lost'; ticketId: string }

/** How often a waiting tool re-checks the job table. Injected sleep keeps tests deterministic. */
const DEFAULT_POLL_MS = 250

export interface DeviceWaitOptions {
  timeoutMs: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
}

/** The queue the registry leases from, plus the result table the waiting tool reads. */
export class DeviceBroker {
  readonly registry: DaemonRegistry
  private readonly jobs = new Map<string, Job>()
  /** assignmentId -> the job it belongs to; the registry only reports the assignment id back. */
  private readonly byAssignment = new Map<string, string>()
  private sequence = 0

  constructor(options: DeviceBrokerOptions = {}) {
    this.registry = new DaemonRegistry({
      queue: () => this.queued(),
      now: options.now,
      leaseMs: options.leaseMs,
      maxSlots: options.maxSlots,
      pollPath: options.pollPath ?? '/daemon/lease',
      onLease: assignment => this.rememberLease(assignment),
      onComplete: result => this.rememberResult(result),
    })
  }

  /** Devices whose lease is live; the tool checks this before queueing so it never hangs. */
  onlineDevices(): string[] {
    return this.registry.onlineDevices()
  }

  /** Queue one prompt; returns the synthetic ticket id the job is tracked under. */
  enqueue(request: DeviceJobRequest): { ticketId: string } {
    this.sequence += 1
    const ticketId = `device-job-${this.sequence}`
    this.jobs.set(ticketId, { ticketId, request })
    return { ticketId }
  }

  /** Drop a still-queued job (it was never leased, so no device is executing it). */
  cancel(ticketId: string): void {
    const job = this.jobs.get(ticketId)
    if (!job || job.assignmentId) return
    this.jobs.delete(ticketId)
  }

  /**
   * Wait for the job's result until `timeoutMs` (measured on the injected clock). On timeout the
   * local entry is dropped: a leased assignment keeps executing on the device and still reports to
   * the registry, but a job nobody leased is cancelled. Never rejects.
   */
  async wait(ticketId: string, options: DeviceWaitOptions): Promise<DeviceWaitOutcome> {
    const job = this.jobs.get(ticketId)
    if (!job) return { kind: 'lost', ticketId }
    const now = options.now ?? (() => Date.now())
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) }))
    const pollMs = Math.max(1, options.pollMs ?? DEFAULT_POLL_MS)
    const deadline = now() + Math.max(0, options.timeoutMs)
    for (;;) {
      if (job.result) {
        this.jobs.delete(ticketId)
        if (job.assignmentId) this.byAssignment.delete(job.assignmentId)
        return { kind: 'result', result: job.result }
      }
      const remaining = deadline - now()
      if (remaining <= 0) {
        const assignmentId = job.assignmentId
        this.jobs.delete(ticketId)
        if (assignmentId) this.byAssignment.delete(assignmentId)
        return { kind: 'timeout', ticketId, ...(assignmentId ? { assignmentId } : {}) }
      }
      await sleep(Math.min(pollMs, remaining))
    }
  }

  private queued(): QueuedWork[] {
    return [...this.jobs.values()].map(job => ({
      ticketId: job.ticketId,
      brief: job.request.prompt,
      workdir: job.request.workdir,
      ...(job.request.device ? { device: job.request.device } : {}),
    }))
  }

  private rememberLease(assignment: Assignment): void {
    const job = this.jobs.get(assignment.ticketId)
    if (!job) return
    job.assignmentId = assignment.assignmentId
    this.byAssignment.set(assignment.assignmentId, assignment.ticketId)
  }

  private rememberResult(result: DaemonResult): void {
    const ticketId = this.byAssignment.get(result.assignmentId)
    if (!ticketId) return
    const job = this.jobs.get(ticketId)
    if (!job) return
    job.result = result
  }
}
