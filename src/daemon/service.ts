/**
 * Process-level singleton for the device broker.
 *
 * The cloud HTTP endpoints and the worker-side `device` tool must see the same queue, so they share
 * one broker (and therefore one `DaemonRegistry`). The state is in-memory by design: a container
 * restart loses devices, leases and queued device jobs; the next register/heartbeat rebuilds it.
 */
import { DeviceBroker } from './broker.ts'

let singleton: DeviceBroker | undefined

/** The one broker this process uses for daemon traffic. */
export function daemonBroker(): DeviceBroker {
  singleton ??= new DeviceBroker()
  return singleton
}

/** Test hook: forget the process-level broker so a spec starts from an empty registry. */
export function resetDaemonBroker(): void {
  singleton = undefined
}
