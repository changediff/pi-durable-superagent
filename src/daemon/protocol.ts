/**
 * Wire protocol shared by the cloud registry, the device daemon client and the HTTP transport.
 *
 * Nothing here touches the domain store: the daemon receives a brief and returns a result, and the
 * cloud maps either side onto tickets/workers in a later cut.
 */

/** What a device announces when it comes online. */
export interface RegisterRequest {
  deviceId: string
  label: string
  model: string
  /** Requested concurrency; the cloud caps it. */
  slots?: number
  workdirs?: string[]
}

/** The cloud's answer: how long a lease lasts, how many slots were granted, where to poll. */
export interface RegisterResponse {
  deviceId: string
  leaseMs: number
  pollPath: string
  slots: number
}

/** One unit of work handed to a device for the duration of its lease. */
export interface Assignment {
  assignmentId: string
  ticketId: string
  brief: string
  workdir: string
  /** ISO timestamp after which the cloud may reclaim the assignment if no heartbeat renewed it. */
  deadlineAt: string
}

/** The only three result statuses the protocol accepts. */
export type DaemonResultStatus = 'done' | 'failed' | 'blocked'

/** The device's verdict on one assignment. `assignmentId` makes delivery idempotent. */
export interface DaemonResult {
  assignmentId: string
  status: DaemonResultStatus
  text: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

/** Keeps a device lease (and its in-flight assignment leases) alive. */
export interface HeartbeatRequest {
  deviceId: string
  running?: string[]
}

/** Online flag plus the assignments the cloud believes the device is running. */
export interface HeartbeatResponse {
  online: boolean
  running?: string[]
  error?: string
}
