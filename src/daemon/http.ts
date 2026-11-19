/**
 * Cloud-side HTTP surface for the device daemon (`POST /daemon/*`).
 *
 * The routes are mounted on the A2A server's listener rather than opening a second port: the
 * container publishes one port, both surfaces share the same lifecycle, and only the paths and the
 * bearer token differ (device token here, A2A token there). `DaemonHttpApi` is transport-agnostic
 * for tests: `handle()` takes a plain request object, while `handleNode()` is the thin adapter for
 * `node:http`. Nothing here sends an outbound request.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { DaemonRegistry } from './registry.ts'
import type { DaemonResult, DaemonResultStatus, RegisterRequest } from './protocol.ts'

/** Default long-poll window; the client asks for less, the server caps at this. */
export const DEFAULT_LEASE_WAIT_MS = 25_000
const MAX_BODY = 1024 * 1024
const STATUSES: readonly DaemonResultStatus[] = ['done', 'failed', 'blocked']

/** One request in a shape a test can build without a socket. */
export interface DaemonHttpRequest {
  method: string
  /** Path plus optional query, e.g. `/daemon/lease` or `/daemon/poll?wait=0`. */
  path: string
  authorization?: string
  /** Parsed JSON body for POST routes. */
  body?: unknown
}

export interface DaemonHttpResponse {
  status: number
  /** Omitted for 204. */
  body?: unknown
}

export interface DaemonHttpOptions {
  registry: DaemonRegistry
  /** Bearer token every `/daemon/*` request must present. Empty rejects every request. */
  token: string
  log(message: string, detail?: unknown): void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** How often an idle long-poll re-checks the queue. */
  pollIntervalMs?: number
  /** Upper bound of one long-poll, regardless of what the body asks for. */
  maxWaitMs?: number
}

/** Constant-time bearer comparison; length mismatch returns before `timingSafeEqual` can throw. */
function bearerMatches(authorization: string | undefined, token: string): boolean {
  if (!token || !authorization) return false
  const expected = `Bearer ${token}`
  if (authorization.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(authorization), Buffer.from(expected))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

export class DaemonHttpApi {
  private readonly registry: DaemonRegistry
  private readonly token: string
  private readonly log: (message: string, detail?: unknown) => void
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly pollIntervalMs: number
  private readonly maxWaitMs: number

  constructor(options: DaemonHttpOptions) {
    this.registry = options.registry
    this.token = options.token
    this.log = options.log
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms) }))
    this.pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 250)
    this.maxWaitMs = Math.max(0, options.maxWaitMs ?? DEFAULT_LEASE_WAIT_MS)
    if (!this.token) this.log('daemon warning: SUP_DAEMON_TOKEN is empty; every /daemon request will be rejected')
    this.log('daemon registry is in-memory; registered devices, leases and queued device jobs reset on restart')
  }

  /** Route one request. Never throws; unexpected failures become a logged 500. */
  async handle(request: DaemonHttpRequest): Promise<DaemonHttpResponse> {
    try {
      const [path = '/', query = ''] = request.path.split('?', 2)
      if (path !== '/daemon' && !path.startsWith('/daemon/')) {
        return { status: 404, body: { error: 'not found' } }
      }
      if (!bearerMatches(request.authorization, this.token)) {
        return { status: 401, body: { error: 'unauthorized' } }
      }
      const method = request.method.toUpperCase()
      if (method === 'POST' && path === '/daemon/register') return this.register(request.body)
      if (method === 'POST' && path === '/daemon/heartbeat') return this.heartbeat(request.body)
      if (method === 'POST' && path === '/daemon/lease') return await this.lease(request.body, new URLSearchParams(query))
      // The pre-wire client polled with GET; keep it working so an older device binary can reconnect.
      if (method === 'GET' && path === '/daemon/poll') return await this.lease(undefined, new URLSearchParams(query))
      if (method === 'POST' && path === '/daemon/result') return this.result(request.body)
      return { status: 404, body: { error: `not found: ${method} ${path}` } }
    } catch (error) {
      this.log('daemon request failed', String((error as Error)?.message ?? error))
      return { status: 500, body: { error: 'internal error' } }
    }
  }

  /**
   * Adapter for `node:http`. Returns false when the path is not ours, so the A2A route table can
   * handle it; the caller only invokes this for `/daemon*` paths.
   */
  async handleNode(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = req.url ?? '/'
    let body: unknown
    if ((req.method ?? 'GET').toUpperCase() === 'POST') {
      try {
        body = await readJson(req)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const status = message === 'body too large' ? 413 : 400
        writeJson(res, status, { error: message })
        return true
      }
    }
    const result = await this.handle({
      method: req.method ?? 'GET',
      path,
      authorization: req.headers.authorization,
      body,
    })
    writeJson(res, result.status, result.body)
    return true
  }

  private register(raw: unknown): DaemonHttpResponse {
    const body = isRecord(raw) ? raw : {}
    const deviceId = nonEmptyString(body.deviceId)
    if (!deviceId) return { status: 400, body: { error: 'deviceId is required' } }
    const request: RegisterRequest = {
      deviceId,
      label: nonEmptyString(body.label) ?? deviceId,
      model: nonEmptyString(body.model) ?? 'unknown',
      ...(typeof body.slots === 'number' ? { slots: body.slots } : {}),
      ...(Array.isArray(body.workdirs) ? { workdirs: body.workdirs.filter((item): item is string => typeof item === 'string') } : {}),
    }
    const response = this.registry.register(request)
    this.log('daemon registered', { deviceId: response.deviceId, slots: response.slots, leaseMs: response.leaseMs })
    return { status: 200, body: response }
  }

  private heartbeat(raw: unknown): DaemonHttpResponse {
    const body = isRecord(raw) ? raw : {}
    const deviceId = nonEmptyString(body.deviceId)
    if (!deviceId) return { status: 400, body: { error: 'deviceId is required' } }
    const running = Array.isArray(body.running)
      ? body.running.filter((item): item is string => typeof item === 'string')
      : []
    const response = this.registry.heartbeat(deviceId, running)
    this.log('daemon heartbeat', { deviceId, online: response.online, running: running.length })
    // After a container restart the registry is empty again; the device must register anew.
    if (!response.online) this.log('daemon heartbeat: unknown device, register again', { deviceId, error: response.error })
    return { status: 200, body: response }
  }

  private async lease(raw: unknown, query: URLSearchParams): Promise<DaemonHttpResponse> {
    const body = isRecord(raw) ? raw : {}
    const deviceId = nonEmptyString(body.deviceId) ?? nonEmptyString(query.get('deviceId'))
    if (!deviceId) return { status: 400, body: { error: 'deviceId is required' } }
    const requested = Number(body.waitSeconds ?? query.get('wait') ?? 0)
    const waitMs = Math.min(this.maxWaitMs, Number.isFinite(requested) && requested > 0 ? requested * 1_000 : 0)
    const deadline = this.now() + waitMs
    for (;;) {
      const assignment = this.registry.lease(deviceId)
      if (assignment) {
        this.log('daemon lease handoff', {
          deviceId,
          assignmentId: assignment.assignmentId,
          ticketId: assignment.ticketId,
        })
        return { status: 200, body: assignment }
      }
      const remaining = deadline - this.now()
      if (remaining <= 0) return { status: 204 }
      await this.sleep(Math.min(this.pollIntervalMs, remaining))
    }
  }

  private result(raw: unknown): DaemonHttpResponse {
    const body = isRecord(raw) ? raw : {}
    const assignmentId = nonEmptyString(body.assignmentId)
    if (!assignmentId) return { status: 400, body: { error: 'assignmentId is required' } }
    // `completed` is accepted as an alias for the wire's `done`; both mean the work finished.
    const rawStatus = body.status === 'completed' ? 'done' : body.status
    if (!STATUSES.includes(rawStatus as DaemonResultStatus)) {
      return { status: 400, body: { error: `invalid status: ${String(body.status)}` } }
    }
    const status = rawStatus as DaemonResultStatus
    const result: DaemonResult = {
      assignmentId,
      status,
      text: typeof body.text === 'string' ? body.text : '',
      ...(isRecord(body.usage) ? { usage: body.usage } : {}),
    }
    // A retry after a network blip arrives with no live lease; acknowledge it as a duplicate.
    const prior = this.registry.completedResult(assignmentId)
    if (prior) {
      const duplicate = { ok: true as const, duplicate: true as const, assignmentId, status: prior.status }
      this.log('daemon result received', { assignmentId, status: prior.status, duplicate: true })
      return { status: 200, body: duplicate }
    }
    // The lease, not the body, names the reporting device; a token holder cannot complete another
    // device's assignment by claiming its id.
    const deviceId = this.registry.deviceOf(assignmentId)
    if (!deviceId) {
      this.log('daemon result rejected', { assignmentId, error: 'unknown or expired assignment' })
      return { status: 409, body: { ok: false, error: `unknown assignment ${assignmentId}` } }
    }
    const outcome = this.registry.complete(deviceId, result)
    if (!outcome.ok) {
      this.log('daemon result rejected', { deviceId, assignmentId, error: outcome.error })
      return { status: 409, body: { ok: false, error: outcome.error } }
    }
    this.log('daemon result received', {
      deviceId,
      assignmentId,
      status: outcome.status,
      duplicate: outcome.duplicate,
      chars: result.text.length,
    })
    return { status: 200, body: outcome }
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status)
    res.end()
    return
  }
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text ? JSON.parse(text) : undefined)
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}
