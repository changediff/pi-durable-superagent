#!/usr/bin/env node
/**
 * Device-side daemon entrypoint (BYOM, first cut).
 *
 * Thin shell around `DeviceDaemon`: environment in, `fetch` transport out. An assignment runs
 * through the local agent CLI in print mode (`<cmd> -p <prompt> --output-format json`) and the
 * parsed `result` field is reported back. The daemon never reads model credentials: they belong to
 * the local CLI's own environment.
 *
 *   SUP_DAEMON_URL       cloud base URL (required)
 *   SUP_DAEMON_TOKEN     per-device bearer token (required)
 *   SUP_DAEMON_ID        device ID (required)
 *   SUP_DAEMON_MODEL     model label announced to the cloud (required)
 *   SUP_DAEMON_EXEC_CMD  local agent CLI to run (e.g. `cc`); unset = report `blocked`, protocol-only
 *   SUP_DAEMON_LABEL     host label (default: os hostname)
 *   SUP_DAEMON_SLOTS     requested concurrency (cloud caps at 4)
 *   SUP_DAEMON_WORKDIRS  comma-separated advertised workdirs
 *
 * `--once` registers, heartbeats, polls once and exits — useful for end-to-end verification.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { statSync } from 'node:fs'
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
const STDERR_TAIL_BYTES = 2048

interface FetchTransport extends DaemonTransport {
  /** Set by `register`; the poll path is cloud-assigned. */
  pollPath: string
}

function buildTransport(baseUrl: string, token: string, deviceId: string): FetchTransport {
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
    pollPath: '/daemon/lease',

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
      // Long-poll: the cloud holds the request for up to 25s and answers 204 when idle.
      const response = await post(transport.pollPath, { deviceId, waitSeconds: POLL_WAIT_SECONDS })
      if (response.status === 204) return null
      if (!response.ok) throw await failure('lease', response)
      const assignment = (await response.json()) as Assignment
      if (!assignment || typeof assignment.assignmentId !== 'string') {
        throw new Error('lease returned an invalid assignment')
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

/** Keep at most the last `limit` bytes of a UTF-8 string (a JSON.stringify of a Buffer is ugly). */
function tailBytes(text: string, limit = STDERR_TAIL_BYTES): string {
  const buffer = Buffer.from(text)
  return buffer.length <= limit ? text : buffer.subarray(buffer.length - limit).toString('utf8')
}

/** The assignment's workdir when it exists here; otherwise the daemon's own cwd. */
function localWorkdir(workdir: string, log: (message: string, detail?: unknown) => void): string {
  try {
    if (workdir && statSync(workdir).isDirectory()) return workdir
  } catch { /* fall through */ }
  if (workdir) log('assignment workdir missing; using daemon cwd', { workdir, cwd: process.cwd() })
  return process.cwd()
}

interface SpawnOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

/** Run the local agent CLI and turn its print-mode JSON into a daemon result. */
export function createLocalExecutor(
  command: string | undefined,
  log: (message: string, detail?: unknown) => void,
): (assignment: Assignment) => Promise<DaemonResult> {
  return async (assignment: Assignment): Promise<DaemonResult> => {
    if (!command) {
      log('executor 未配置：SUP_DAEMON_EXEC_CMD unset', { assignmentId: assignment.assignmentId })
      return {
        assignmentId: assignment.assignmentId,
        status: 'blocked',
        text: 'executor 未配置：daemon 未设置 SUP_DAEMON_EXEC_CMD（例如 cc）；设置后才会执行任务。',
      }
    }
    const cwd = localWorkdir(assignment.workdir, log)
    log('daemon executing', { assignmentId: assignment.assignmentId, command, cwd })
    let child: ChildProcess
    try {
      child = spawn(command, ['-p', assignment.brief, '--output-format', 'json'], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      return {
        assignmentId: assignment.assignmentId,
        status: 'failed',
        text: `执行失败：无法启动 ${command}（${String((error as Error)?.message ?? error)}）`,
      }
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
    const outcome = await new Promise<SpawnOutcome>(resolve => {
      let settled = false
      const done = (value: SpawnOutcome): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      child.on('error', error => done({ code: null, signal: null, error }))
      child.on('close', (code, signal) => done({ code, signal }))
    })
    const tail = tailBytes(stderr)
    if (outcome.error) {
      log('daemon execute spawn failed', { assignmentId: assignment.assignmentId, error: outcome.error.message })
      return {
        assignmentId: assignment.assignmentId,
        status: 'failed',
        text: `执行失败：无法启动 ${command}（${outcome.error.message}）\n${tail ? `stderr 尾部 2KB:\n${tail}` : ''}`.trim(),
      }
    }
    if (outcome.code !== 0) {
      log('daemon execute exited non-zero', { assignmentId: assignment.assignmentId, code: outcome.code, signal: outcome.signal })
      return {
        assignmentId: assignment.assignmentId,
        status: 'failed',
        text: [
          `执行失败：${command} 退出码 ${outcome.code ?? 'null'}${outcome.signal ? `（signal ${outcome.signal}）` : ''}`,
          tail ? `stderr 尾部 2KB:\n${tail}` : 'stderr 尾部 2KB: (空)',
        ].join('\n'),
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(stdout)
    } catch {
      log('daemon execute returned invalid JSON', { assignmentId: assignment.assignmentId, chars: stdout.length })
      return {
        assignmentId: assignment.assignmentId,
        status: 'failed',
        text: [
          `执行失败：${command} 的输出不是 JSON`,
          tail ? `stderr 尾部 2KB:\n${tail}` : 'stderr 尾部 2KB: (空)',
        ].join('\n'),
      }
    }
    const result = (parsed as { result?: unknown } | null)?.result
    if (typeof result !== 'string') {
      log('daemon execute JSON has no result field', { assignmentId: assignment.assignmentId })
      return {
        assignmentId: assignment.assignmentId,
        status: 'failed',
        text: [
          `执行失败：${command} 的 JSON 输出没有字符串 result 字段`,
          tail ? `stderr 尾部 2KB:\n${tail}` : 'stderr 尾部 2KB: (空)',
        ].join('\n'),
      }
    }
    return { assignmentId: assignment.assignmentId, status: 'done', text: result }
  }
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
  // Unset means protocol-only mode: the daemon still registers and leases, but reports `blocked`.
  const execCmd = env.SUP_DAEMON_EXEC_CMD?.trim() || undefined

  const daemon = new DeviceDaemon({
    deviceId: deviceId!,
    label: env.SUP_DAEMON_LABEL || hostname(),
    model: model!,
    slots: integerEnv(env.SUP_DAEMON_SLOTS),
    workdirs: workdirs.length ? workdirs : undefined,
    transport: buildTransport(url!, token!, deviceId!),
    execute: createLocalExecutor(execCmd, log),
    log,
    once,
  })

  const stop = (): void => { void daemon.stop() }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)

  log('starting', {
    deviceId,
    model,
    once,
    slots: integerEnv(env.SUP_DAEMON_SLOTS) ?? 1,
    executor: execCmd ?? 'blocked (SUP_DAEMON_EXEC_CMD unset)',
  })
  await daemon.run()
  log('stopped')
}

main().catch(error => {
  console.error('[daemon] fatal', error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
