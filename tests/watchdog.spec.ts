/** Turn watchdog: mode gating, the verdict policy through the loop (fake io, fake clock), KV keys, timer hygiene. No models. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { EntryId } from '@earendil-works/pi-durable'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'
import { resolveSuperagentConfig, type ResolvedSuperagentWatchdogConfig } from '../src/plugin/config.ts'
import { workerConversationKey } from '../src/plugin/worker.ts'
import {
  runTurnWatchdog, type TurnWatchdogHost, type TurnWatchdogIo, type WatchdogVerdict, type WatchdogVerdictKind,
} from '../src/plugin/watchdog.ts'

const TICKET = 't-1'
const INTERVAL = 1_000

const verdict = (kind: WatchdogVerdictKind, reason = '测试判定'): WatchdogVerdict => ({ verdict: kind, reason })

/** Test fixture: mint a branded transcript entry id (arbitrary numbers here, durable Seq ids in production). */
const entryId = (n: number): EntryId => n as EntryId

/** Scripted io: the judge hands back one scripted verdict per check; nudge and reads are spies. */
const fakeIo = (script: WatchdogVerdict[]) => {
  const judge = vi.fn(async (): Promise<WatchdogVerdict | undefined> => script.shift())
  const nudge = vi.fn(async (_text: string): Promise<void> => {})
  const readActivity = vi.fn(async (): Promise<{ lines: string[]; tailId?: EntryId }> =>
    ({ lines: ['助手：调用工具 bash(ls)'], tailId: entryId(7) }))
  const io: TurnWatchdogIo = { readActivity, judge, nudge }
  return { io, judge, nudge }
}

const host = (over: Partial<ResolvedSuperagentWatchdogConfig> = {}): TurnWatchdogHost => ({
  settings: {
    mode: 'auto', intervalMs: INTERVAL, model: { provider: 'test', model: 'watchdog' }, maxInterventions: 2, ...over,
  },
  store,
  ticketId: TICKET,
  log: () => {},
  now: () => '2026-11-19T00:00:00.000Z',
})

/** Let the check a timer tick started run to completion (its awaits are all immediate fakes). */
const settle = async (): Promise<void> => { for (let i = 0; i < 10; i++) await Promise.resolve() }

let directory: string
let store: Store

beforeEach(() => {
  vi.useFakeTimers()
  directory = mkdtempSync(join(tmpdir(), 'sup-watchdog-'))
  store = new Store(join(directory, 'db.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(directory, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('turn watchdog', () => {
  it('off: never consults the judge', async () => {
    const config = resolveSuperagentConfig({
      stateDir: directory, workDir: directory, harnessDir: directory, maxWorkers: 1, evalMode: 'off',
      router: { provider: 'test', model: 'router' }, worker: { provider: 'test', model: 'worker' },
      channel: { send: async () => 'sent' },
    })
    expect(config.watchdog.mode).toBe('off')
    const { io, judge } = fakeIo([verdict('stalled')])
    const dog = runTurnWatchdog(host({ mode: 'off' }), io)
    await vi.advanceTimersByTimeAsync(5 * INTERVAL)
    expect(judge).toHaveBeenCalledTimes(0)
    expect(dog.checks).toBe(0)
    expect(store.get(KV.watchdog.verdicts(TICKET))).toBeUndefined()
    await dog.stop()
  })

  it('observe: records a stalled verdict without nudging or aborting', async () => {
    const { io, judge, nudge } = fakeIo([verdict('stalled')])
    const dog = runTurnWatchdog(host({ mode: 'observe' }), io)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    await settle()
    expect(judge).toHaveBeenCalledTimes(1)
    expect(dog.checks).toBe(1)
    expect(nudge).toHaveBeenCalledTimes(0)
    let aborted: string | undefined
    void dog.aborted.then(summary => { aborted = summary })
    expect(aborted).toBeUndefined()
    const records = store.get(KV.watchdog.verdicts(TICKET))!
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ verdict: 'stalled', action: 'recorded', interventions: 0 })
    await dog.stop()
  })

  it('auto: nudges once on the first stalled verdict', async () => {
    const { io, nudge } = fakeIo([verdict('stalled', '没有新的工具调用')])
    const dog = runTurnWatchdog(host(), io)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    await settle()
    expect(nudge).toHaveBeenCalledTimes(1)
    expect(nudge).toHaveBeenCalledWith(expect.stringContaining('看护提示'))
    expect(store.get(KV.watchdog.verdicts(TICKET))![0]).toMatchObject({ action: 'nudge', interventions: 1 })
    let aborted: string | undefined
    void dog.aborted.then(summary => { aborted = summary })
    expect(aborted).toBeUndefined()
    await dog.stop()
  })

  it('auto: aborts on a second consecutive stalled verdict, for the failed-report path', async () => {
    const { io, nudge } = fakeIo([verdict('stalled', '五分钟没有新输出'), verdict('stalled', '仍然没有新输出')])
    const dog = runTurnWatchdog(host(), io)
    await vi.advanceTimersByTimeAsync(2 * INTERVAL)
    // The runner reports this on the failed path as `执行失败：${summary}` (worker.ts's watchdog branch).
    const summary = await dog.aborted
    expect(summary).toContain('watchdog 判定卡死')
    expect(summary).toContain('stalled')
    expect(nudge).toHaveBeenCalledTimes(1)
    const records = store.get(KV.watchdog.verdicts(TICKET))!
    expect(records).toHaveLength(2)
    expect(records[1]).toMatchObject({ verdict: 'stalled', action: 'abort', interventions: 1 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('auto: an advancing verdict never intervenes', async () => {
    const { io, nudge } = fakeIo([verdict('advancing'), verdict('advancing')])
    const dog = runTurnWatchdog(host(), io)
    await vi.advanceTimersByTimeAsync(2 * INTERVAL)
    await settle()
    expect(dog.checks).toBe(2)
    expect(nudge).toHaveBeenCalledTimes(0)
    const records = store.get(KV.watchdog.verdicts(TICKET))!
    expect(records).toHaveLength(2)
    expect(records.every(record => record.action === 'none')).toBe(true)
    await dog.stop()
  })

  it('keys its session apart from the worker conversation', () => {
    expect(KV.watchdog.conversation(TICKET)).toBe(`watchdog-conv:${TICKET}`)
    expect(workerConversationKey(TICKET)).toBe(`worker-conv:${TICKET}`)
    expect(KV.watchdog.conversation(TICKET)).not.toBe(workerConversationKey(TICKET))
  })

  it('stop() ends the loop and leaves no pending timer', async () => {
    const { io, judge } = fakeIo([verdict('advancing')])
    const dog = runTurnWatchdog(host(), io)
    await vi.advanceTimersByTimeAsync(INTERVAL)
    await settle()
    expect(dog.checks).toBe(1)
    expect(vi.getTimerCount()).toBeGreaterThan(0) // the next sample's sleep is pending
    await dog.stop()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * INTERVAL)
    expect(judge).toHaveBeenCalledTimes(1)
    expect(dog.checks).toBe(1)
  })
})
