/**
 * In-memory device registry and lease bookkeeping for the BYOM daemon.
 *
 * The registry is deliberately storage-free: its only source of work is the injected queue reader,
 * so it can be exercised deterministically and wired to the real durable queue in a later cut.
 * Semantics mirror `docs/013-byom-daemon.md`: leases, not locks; heartbeats renew them; an expired
 * lease returns the work to the queue; results are idempotent by `assignmentId`.
 */
import type {
  Assignment,
  DaemonResult,
  DaemonResultStatus,
  HeartbeatResponse,
  RegisterRequest,
  RegisterResponse,
} from './protocol.ts'

/** One queue entry as the registry sees it (booleans and internal state stay in the store). */
export interface QueuedWork {
  ticketId: string
  brief: string
  workdir: string
}

/** Reads currently assignable work; a ticket already leased is skipped even if still listed. */
export type QueueReader = () => readonly QueuedWork[]

export interface RegistryOptions {
  queue: QueueReader
  /** Injectable clock in epoch milliseconds. */
  now?: () => number
  /** Lease length; heartbeats renew it. */
  leaseMs?: number
  /** Hard cap on per-device concurrency (the protocol's default is 1). */
  maxSlots?: number
  /** Poll path handed back by `register`. */
  pollPath?: string
}

/** Outcome of a result report: `duplicate` means it was already recorded and nothing changed. */
export type CompleteOutcome =
  | { ok: true; duplicate: boolean; assignmentId: string; status: DaemonResultStatus }
  | { ok: false; error: string }

/** Registry counters for logs and tests. */
export interface RegistryStats {
  devices: number
  /** Assignments currently leased (not completed, not expired). */
  leased: number
  /** Queue entries that could be leased right now. */
  queued: number
  /** Assignments reclaimed by expiry over the registry's lifetime. */
  expired: number
}

interface Device {
  deviceId: string
  label: string
  model: string
  slots: number
  running: string[]
  leaseUntil: number
}

interface ActiveAssignment {
  assignment: Assignment
  deviceId: string
  /** Epoch ms; heartbeats push this forward. */
  deadline: number
}

const DEFAULT_LEASE_MS = 60_000
const MAX_SLOTS = 4

export class DaemonRegistry {
  private readonly queue: QueueReader
  private readonly now: () => number
  private readonly leaseMs: number
  private readonly maxSlots: number
  private readonly pollPath: string
  private readonly devices = new Map<string, Device>()
  private readonly assignments = new Map<string, ActiveAssignment>()
  /** Tickets with a live lease, so the same queue entry cannot be handed out twice. */
  private readonly assignedTickets = new Set<string>()
  /** Completed assignment IDs and their results, for idempotent redelivery. */
  private readonly completed = new Map<string, DaemonResult>()
  private sequence = 0
  private expiredCount = 0

  constructor(options: RegistryOptions) {
    this.queue = options.queue
    this.now = options.now ?? (() => Date.now())
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.maxSlots = options.maxSlots ?? MAX_SLOTS
    this.pollPath = options.pollPath ?? '/daemon/poll'
  }

  /** Announce or re-announce a device; returns the granted slots and lease length. */
  register(request: RegisterRequest): RegisterResponse {
    const slots = this.clampSlots(request.slots)
    const leaseUntil = this.now() + this.leaseMs
    const existing = this.devices.get(request.deviceId)
    if (existing) {
      existing.label = request.label
      existing.model = request.model
      existing.slots = slots
      existing.leaseUntil = leaseUntil
    } else {
      this.devices.set(request.deviceId, {
        deviceId: request.deviceId,
        label: request.label,
        model: request.model,
        slots,
        running: [],
        leaseUntil,
      })
    }
    return { deviceId: request.deviceId, leaseMs: this.leaseMs, pollPath: this.pollPath, slots }
  }

  /**
   * Renew a device lease and every assignment leased to it. Unknown devices are reported, not thrown.
   * `running` is advisory: the daemon lists the assignment IDs still executing.
   */
  heartbeat(deviceId: string, running: string[] = []): HeartbeatResponse {
    // Sweep first: a lease that already lapsed cannot be revived by a late heartbeat.
    this.expire()
    const device = this.devices.get(deviceId)
    if (!device) return { online: false, error: `unknown device ${deviceId}` }
    const deadline = this.now() + this.leaseMs
    device.leaseUntil = deadline
    device.running = [...running]
    for (const active of this.assignments.values()) {
      if (active.deviceId === deviceId) active.deadline = deadline
    }
    return { online: true, running: device.running }
  }

  /**
   * Lease one queue entry to a device with a free slot.
   * A queue entry already leased elsewhere is never handed out twice.
   */
  lease(deviceId: string): Assignment | undefined {
    this.expire()
    const device = this.devices.get(deviceId)
    if (!device) return undefined
    if (this.activeFor(deviceId) >= device.slots) return undefined
    const work = this.nextWork()
    if (!work) return undefined
    const deadline = this.now() + this.leaseMs
    const assignment: Assignment = {
      assignmentId: this.nextId(),
      ticketId: work.ticketId,
      brief: work.brief,
      workdir: work.workdir,
      deadlineAt: new Date(deadline).toISOString(),
    }
    this.assignments.set(assignment.assignmentId, { assignment, deviceId, deadline })
    this.assignedTickets.add(work.ticketId)
    return assignment
  }

  /**
   * Record a device's result. A repeated `assignmentId` is acknowledged as a duplicate without
   * changing state; an unknown or foreign assignment is reported as an error instead of throwing.
   */
  complete(deviceId: string, result: DaemonResult): CompleteOutcome {
    const prior = this.completed.get(result.assignmentId)
    if (prior) {
      return { ok: true, duplicate: true, assignmentId: result.assignmentId, status: prior.status }
    }
    if (!this.devices.has(deviceId)) return { ok: false, error: `unknown device ${deviceId}` }
    const active = this.assignments.get(result.assignmentId)
    if (!active) return { ok: false, error: `unknown assignment ${result.assignmentId}` }
    if (active.deviceId !== deviceId) {
      return { ok: false, error: `assignment ${result.assignmentId} is leased to another device` }
    }
    this.assignments.delete(result.assignmentId)
    this.assignedTickets.delete(active.assignment.ticketId)
    this.completed.set(result.assignmentId, result)
    return { ok: true, duplicate: false, assignmentId: result.assignmentId, status: result.status }
  }

  /** Return every assignment whose lease lapsed to the queue; returns the reclaimed IDs. */
  expire(): string[] {
    const now = this.now()
    const reclaimed: string[] = []
    for (const [assignmentId, active] of this.assignments) {
      if (active.deadline > now) continue
      this.assignments.delete(assignmentId)
      this.assignedTickets.delete(active.assignment.ticketId)
      reclaimed.push(assignmentId)
    }
    this.expiredCount += reclaimed.length
    return reclaimed
  }

  /** A device is online only while its device lease is unexpired. */
  online(deviceId: string): boolean {
    const device = this.devices.get(deviceId)
    return device !== undefined && this.now() < device.leaseUntil
  }

  /** Counters for logs and tests; does not mutate registry state. */
  stats(): RegistryStats {
    const now = this.now()
    let leased = 0
    const liveTickets = new Set<string>()
    for (const active of this.assignments.values()) {
      if (active.deadline <= now) continue
      leased += 1
      liveTickets.add(active.assignment.ticketId)
    }
    const queuedTickets = new Set<string>()
    for (const work of this.queue()) {
      if (work?.ticketId && !liveTickets.has(work.ticketId)) queuedTickets.add(work.ticketId)
    }
    return { devices: this.devices.size, leased, queued: queuedTickets.size, expired: this.expiredCount }
  }

  private clampSlots(requested: number | undefined): number {
    if (requested === undefined || !Number.isFinite(requested)) return 1
    return Math.max(1, Math.min(this.maxSlots, Math.trunc(requested)))
  }

  private activeFor(deviceId: string): number {
    let count = 0
    for (const active of this.assignments.values()) if (active.deviceId === deviceId) count += 1
    return count
  }

  private nextWork(): QueuedWork | undefined {
    const seen = new Set<string>()
    for (const work of this.queue()) {
      if (!work?.ticketId || seen.has(work.ticketId) || this.assignedTickets.has(work.ticketId)) continue
      seen.add(work.ticketId)
      return work
    }
    return undefined
  }

  private nextId(): string {
    this.sequence += 1
    return `assignment-${this.sequence}`
  }
}
