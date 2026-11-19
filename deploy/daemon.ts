#!/usr/bin/env node
/**
 * Device-side daemon entrypoint (BYOM, first cut).
 *
 * Thin shell around `DeviceDaemon`: environment in, `fetch` transport out. This cut deliberately
 * refuses to execute assignments — it prints "executor 未配置" and reports `blocked` — because
 * wiring the local model/tools is the next cut. It never reads model credentials.
 *
 *   SUP_DAEMON_URL    cloud base URL (required)
 *   SUP_DAEMON_TOKEN  per-device bearer token (required)
 *   SUP_DAEMON_ID     device ID (required)
 *   SUP_DAEMON_MODEL  model label announced to the cloud (required)
 *   SUP_DAEMON_LABEL  host label (default: os hostname)
 *   SUP_DAEMON_SLOTS  requested concurrency (cloud caps at 4)
 *   SUP_DAEMON_WORKDIRS comma-separated advertised workdirs
 *
 * `--once` registers, heartbeats, polls once and exits — useful for end-to-end verification.
 */
import { hostname } from 'node:os'
import { DeviceDaemon, type DaemonTransport } from '../src/daemon/client.ts'
import type {
  Assignment,
  DaemonResult,
  HeartbeatRequest,
  HeartbeatResponse,
  RegisterRequest,
  RegisterResponse,
} from '../src/daemon/protocol.ts'

const POLL_WAIT_SECONDS = 25

interface FetchTransport extends DaemonTransport {
  /** Set by `register`; the poll path is cloud-assigned. */
  pollPath: string
}

function buildTransport(baseUrl: string, token: string): FetchTransport {
  const base = baseUrl.replace(/\/+$/, '')
  const headers = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  }
  const endpoint = (path: string): string =>
    /^https?:\/\//i.test(path) ? path : `${base}${path.startsWith('/') ? '' : '/'}${path}`

  const failure = async (call: string, response: Response): Promise<Error> => {
    const body = await response.text().catch(() => '')
    const detail = body ? `: ${body.slice(0, 300)}` : ''
    return new Error(`${call} failed with HTTP ${response.status}${detail}`)
  }

  const post = async (path: string, body: unknown): Promise<Response> =>
    fetch(endpoint(path), { method: 'POST', headers, body: JSON.stringify(body) })

  const transport: FetchTransport = {
    pollPath: '/daemon/poll',

    async register(request: RegisterRequest): Promise<RegisterResponse> {
      const response = await post('/daemon/register', request)
      if (!response.ok) throw await failure('register', response)
      const data = (await response.json()) as RegisterResponse
      if (!data || typeof data.leaseMs !== 'number') throw new Error('register returned an invalid response')
      if (typeof data.pollPath === 'string' && data.pollPath) transport.pollPath = data.pollPath
      return data
    },

    async heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse> {
      const response = await post('/daemon/heartbeat', request)
      if (!response.ok) throw await failure('heartbeat', response)
      return (await response.json()) as HeartbeatResponse
    },

    async poll(): Promise<Assignment | null> {
      const path = transport.pollPath
      const url = `${endpoint(path)}${path.includes('?') ? '&' : '?'}wait=${POLL_WAIT_SECONDS}`
      const response = await fetch(url, { method: 'GET', headers })
      if (response.status === 204) return null
      if (!response.ok) throw await failure('poll', response)
      const assignment = (await response.json()) as Assignment
      if (!assignment || typeof assignment.assignmentId !== 'string') {
        throw new Error('poll returned an invalid assignment')
      }
      return assignment
    },

    async result(result: DaemonResult): Promise<void> {
      const response = await post('/daemon/result', result)
      if (!response.ok) throw await failure('result', response)
    },
  }
  return transport
}

function integerEnv(value: string | undefined): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : undefined
}

async function main(): Promise<void> {
  const env = process.env
  const url = env.SUP_DAEMON_URL
  const token = env.SUP_DAEMON_TOKEN
  const deviceId = env.SUP_DAEMON_ID
  const model = env.SUP_DAEMON_MODEL
  const missing = [
    ['SUP_DAEMON_URL', url],
    ['SUP_DAEMON_TOKEN', token],
    ['SUP_DAEMON_ID', deviceId],
    ['SUP_DAEMON_MODEL', model],
  ].filter(([, value]) => !value).map(([name]) => name)
  if (missing.length) {
    console.error(`[daemon] missing required environment: ${missing.join(', ')}`)
    process.exitCode = 1
    return
  }

  const log = (message: string, detail?: unknown): void => {
    console.log(`[daemon] ${message}`, detail === undefined ? '' : JSON.stringify(detail))
  }
  const workdirs = (env.SUP_DAEMON_WORKDIRS ?? '').split(',').map(item => item.trim()).filter(Boolean)
  const once = process.argv.includes('--once')

  const daemon = new DeviceDaemon({
    deviceId: deviceId!,
    label: env.SUP_DAEMON_LABEL || hostname(),
    model: model!,
    slots: integerEnv(env.SUP_DAEMON_SLOTS),
    workdirs: workdirs.length ? workdirs : undefined,
    transport: buildTransport(url!, token!),
    // The local executor (model + tools) is the next cut; refuse work explicitly for now.
    execute: async (assignment: Assignment): Promise<DaemonResult> => {
      log('executor 未配置', { assignmentId: assignment.assignmentId, ticketId: assignment.ticketId })
      return {
        assignmentId: assignment.assignmentId,
        status: 'blocked',
        text: 'executor 未配置：daemon 尚无本地执行器',
      }
    },
    log,
    once,
  })

  const stop = (): void => { void daemon.stop() }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  log('starting', { deviceId, model, once, slots: integerEnv(env.SUP_DAEMON_SLOTS) ?? 1 })
  await daemon.run()
  log('stopped')
}

main().catch(error => {
  console.error('[daemon] fatal', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
