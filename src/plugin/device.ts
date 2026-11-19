/**
 * The worker-side `device` tool: hand one prompt to an online BYOM device and return its answer.
 *
 * The tool is a thin face over the process-level `DeviceBroker`: it refuses immediately when no
 * device is online (a worker must not stall on a laptop that is not there), queues the prompt,
 * and waits for the result the device reports over the daemon HTTP surface. The assignment stays
 * on the device if the wait times out; the returned text keeps the assignment id so a later turn
 * can refer to it.
 */
import { defineTool } from '@earendil-works/pi-durable'
import { int, obj, opt, str } from '@earendil-works/pi-schema'
import type { DeviceBroker } from '../daemon/broker.ts'

export const DEVICE_TOOL = 'device'
/** A device task is a whole agent turn, so the default is generous; the cap keeps a worker turn bounded. */
export const DEVICE_DEFAULT_TIMEOUT_SEC = 300
export const DEVICE_MAX_TIMEOUT_SEC = 900
const DEVICE_POLL_MS = 250

export interface DeviceToolDeps {
  broker: DeviceBroker
  /** Working directory sent with the assignment (the device falls back to its own cwd if absent). */
  workdir: string
  log(message: string, detail?: unknown): void
  /** Injectable clock/sleep for the timeout test; production uses the real ones. */
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
}

export interface DeviceArgs {
  prompt: string
  device?: string
  timeoutSec?: number
}

/** Clamp `timeoutSec` to the documented 1..900 window. */
export function deviceTimeoutMs(value: number | undefined): number {
  const seconds = Number.isFinite(value) ? Math.trunc(value as number) : DEVICE_DEFAULT_TIMEOUT_SEC
  return Math.max(1, Math.min(DEVICE_MAX_TIMEOUT_SEC, seconds)) * 1_000
}

/** Build the `device` tool against one broker (the plugin passes the process-level singleton). */
export function createDeviceTool(deps: DeviceToolDeps) {
  return defineTool({
    name: DEVICE_TOOL,
    description: 'Hand one prompt to an online BYOM device (a local agent CLI) and return its result text. Prompt and work happen on the device; model credentials never leave it. Fails at once when no device is online.',
    parameters: obj({
      prompt: str({ description: 'The complete task for the device agent, with any context it needs' }),
      device: opt(str({ description: 'Pin the task to one device id; omit to use any online device' })),
      timeoutSec: opt(int({ minimum: 1, maximum: DEVICE_MAX_TIMEOUT_SEC, description: `How long to wait for the result; default ${DEVICE_DEFAULT_TIMEOUT_SEC}s, max ${DEVICE_MAX_TIMEOUT_SEC}s` })),
    }),
    execute: async (args: DeviceArgs) => {
      const online = deps.broker.onlineDevices()
      if (!online.length) {
        deps.log('device tool refused', { reason: 'no device online' })
        return {
          isError: true,
          output: [{ type: 'text', text: `device: 没有在线设备，任务未派发。设备通过 daemon 注册并持续心跳后才会出现在这里。` }],
        }
      }
      if (args.device && !online.includes(args.device)) {
        deps.log('device tool refused', { reason: 'requested device offline', device: args.device, online })
        return {
          isError: true,
          output: [{ type: 'text', text: `device: 设备 "${args.device}" 不在线；当前在线：${online.join(', ')}。任务未派发。` }],
        }
      }

      const timeoutMs = deviceTimeoutMs(args.timeoutSec)
      const job = deps.broker.enqueue({
        prompt: args.prompt,
        workdir: deps.workdir,
        ...(args.device ? { device: args.device } : {}),
      })
      deps.log('device tool queued', {
        ticketId: job.ticketId,
        device: args.device,
        timeoutSec: timeoutMs / 1_000,
        chars: args.prompt.length,
      })

      const outcome = await deps.broker.wait(job.ticketId, {
        timeoutMs,
        now: deps.now,
        sleep: deps.sleep,
        pollMs: deps.pollMs ?? DEVICE_POLL_MS,
      })
      if (outcome.kind === 'lost') {
        deps.log('device tool completed', { ticketId: job.ticketId, status: 'lost' })
        return { isError: true, output: [{ type: 'text', text: `device: 任务 ${job.ticketId} 已不在队列中（可能已被清理）。` }] }
      }
      if (outcome.kind === 'timeout') {
        const assignment = outcome.assignmentId ? `（assignmentId: ${outcome.assignmentId}）` : ''
        deps.log('device tool timed out', {
          ticketId: job.ticketId,
          assignmentId: outcome.assignmentId,
          timeoutSec: timeoutMs / 1_000,
        })
        return {
          isError: true,
          output: [{ type: 'text', text: `device: 已超时，任务仍在设备上执行${assignment}。如需结果，请稍后按 assignmentId 查询或在后续回合重试。` }],
        }
      }

      const { result } = outcome
      if (result.status === 'done') {
        deps.log('device tool completed', { ticketId: job.ticketId, assignmentId: result.assignmentId, status: result.status, chars: result.text.length })
        return { output: [{ type: 'text', text: result.text }] }
      }
      // failed / blocked: the device's reason is the useful content, so hand it back verbatim.
      deps.log('device tool completed', {
        ticketId: job.ticketId,
        assignmentId: result.assignmentId,
        status: result.status,
        chars: result.text.length,
      })
      return {
        isError: true,
        output: [{ type: 'text', text: `device ${result.status}: ${result.text || '(设备没有给出原因)'}` }],
      }
    },
  })
}
