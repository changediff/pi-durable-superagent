/**
 * Async ReAct loop checks for the `start`/`stop`/`list` tools: `start` returns at once while the
 * command keeps running, the finished result re-enters the conversation as a new input message
 * (a fake session records the submit calls), `stop` kills the whole process group, the
 * per-session cap holds at four, oversized output is truncated head+tail, and ending a session
 * kills whatever it left running. Zero network: only /bin/sh and node itself are spawned.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BackgroundJobs, createReactExtension, type ReactSession } from '../src/plugin/react.ts'

/** The fake conversation: records every result message submitted into the session. */
class FakeSession implements ReactSession {
  readonly submissions: { type: string; content: string; requestId?: string; whenBusy?: string }[] = []
  attempts = 0
  refuse = false

  async submit(submission: { type: 'input'; content: string; requestId?: string; whenBusy?: string }): Promise<{ id: string }> {
    this.attempts += 1
    if (this.refuse) throw new Error('conversation aborted')
    this.submissions.push(submission)
    return { id: `sub-${this.submissions.length}` }
  }
}

interface ToolLike { execute(args: unknown, api: unknown, context: unknown): Promise<unknown> }

interface Suite {
  readonly start: ToolLike
  readonly stop: ToolLike
  readonly list: ToolLike
  readonly jobs: BackgroundJobs
  readonly session: FakeSession
}

const suites: Suite[] = []
let directory: string
let call = 0

/** One isolated suite: its own job table and fake session, so tests cannot see each other's jobs. */
const setup = (conversationId = 'conv-1'): Suite => {
  const session = new FakeSession()
  const extension = createReactExtension({
    session: async () => session,
    jobs: new BackgroundJobs(),
    log: () => {},
  })
  const tool = (name: string): ToolLike => withConversation(extension.tools!.find(candidate => candidate.name === name) as ToolLike, conversationId)
  const suite: Suite = {
    start: tool('start'),
    stop: tool('stop'),
    list: tool('list'),
    jobs: extension.jobs,
    session,
  }
  suites.push(suite)
  return suite
}

/** Bind a tool call to one conversation id, the way the harness would. */
const withConversation = (tool: ToolLike, conversationId: string): ToolLike => ({
  execute: (args, _api, context) => tool.execute(args, { conversationId, callId: `call-${++call}` }, context),
})

const started = (result: unknown): { id: string; pid: number } => {
  const structured = (result as { structuredOutput?: { id?: string; status?: string; pid?: number } }).structuredOutput
  expect(structured).toMatchObject({ status: 'started' })
  expect(structured!.id).toMatch(/^bg-/)
  expect(structured!.pid).toBeGreaterThan(0)
  return { id: structured!.id!, pid: structured!.pid! }
}

const waitFor = async (probe: () => boolean, what: string, limitMs = 5000): Promise<void> => {
  const deadline = Date.now() + limitMs
  while (!probe()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 20))
  }
}

/** Poll until `kill(pid, 0)` throws with the given code (ESRCH once the process is gone). */
const killCode = (pid: number): string | undefined => {
  try { process.kill(pid, 0); return undefined } catch (error) { return (error as NodeJS.ErrnoException).code }
}

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'react-async-')) })
afterEach(() => {
  for (const suite of suites) suite.jobs.disposeAll()
  suites.length = 0
  rmSync(directory, { recursive: true, force: true })
})

describe('the async react tools', () => {
  it('start returns at once while the command runs, and its result re-enters the session', async () => {
    const { start, stop, session } = setup()
    const began = Date.now()
    const { id, pid } = started(await start.execute({ command: 'sleep 5' }, undefined, {}))
    expect(Date.now() - began).toBeLessThan(300)
    expect(killCode(pid)).toBeUndefined() // still running
    await stop.execute({ id }, undefined, {})
    await waitFor(() => session.submissions.length === 1, 'the result message to enter the session')
    expect(session.submissions[0]).toMatchObject({ type: 'input', requestId: `react:${id}`, whenBusy: 'followUp' })
    expect(session.submissions[0]!.content).toContain(id)
    expect(session.submissions[0]!.content).toContain('stopped')
  })

  it('delivers command, exit code and output of a finished command', async () => {
    const { start, session } = setup()
    const { id } = started(await start.execute({ command: 'echo ok' }, undefined, {}))
    await waitFor(() => session.submissions.length === 1, 'the result message to enter the session')
    const content = session.submissions[0]!.content
    expect(content).toContain(`命令: echo ok`)
    expect(content).toContain('exit=0')
    expect(content).toContain('ok')
    expect(content).toContain(id)
  })

  it('stop kills the process and reports stopped', async () => {
    const { start, stop, session } = setup()
    const { id, pid } = started(await start.execute({ command: 'sleep 30' }, undefined, {}))
    const stopped = await stop.execute({ id }, undefined, {}) as { isError?: boolean; structuredOutput?: { id: string; status: string } }
    expect(stopped.structuredOutput).toMatchObject({ id, status: 'stopped' })
    expect(stopped.isError).toBeFalsy()
    expect(killCode(pid)).toBe('ESRCH') // really gone, not a leftover or zombie
    await waitFor(() => session.submissions.some(submission => submission.content.includes('status=stopped')), 'the stopped result message')
  })

  it('refuses the fifth concurrent background task of one conversation', async () => {
    const { start } = setup()
    for (let index = 0; index < 4; index++) {
      started(await start.execute({ command: 'sleep 30' }, undefined, {}))
    }
    const fifth = await start.execute({ command: 'sleep 30' }, undefined, {}) as { isError?: boolean; output?: { type: string; text: string }[] }
    expect(fifth.isError).toBe(true)
    expect(fifth.output![0]!.text).toContain('cap 4')
  })

  it('truncates oversized output to head and tail', async () => {
    const { start, session } = setup()
    const command = `node -e "process.stdout.write('A'.repeat(4096) + 'B'.repeat(3004))"`
    await start.execute({ command, cwd: directory }, undefined, {})
    await waitFor(() => session.submissions.length === 1, 'the result message to enter the session')
    const content = session.submissions[0]!.content
    // 7100 bytes out: first 4096 kept, last 2048 kept, the middle 956 summarised.
    expect(content).toContain('… truncated 956 bytes …')
    expect(content).toContain('A'.repeat(64))
    expect(content).toContain('B'.repeat(64))
    expect(content).not.toContain('A'.repeat(5000))
    expect(content.length).toBeLessThan(4096 + 2048 + 600)
  })

  it('kills a session’s leftover jobs when the session ends, without delivering results', async () => {
    const { start, jobs, session } = setup()
    const { pid } = started(await start.execute({ command: 'sleep 30', cwd: directory }, undefined, {}))
    jobs.dispose('conv-1') // what the worker abort path and runtime shutdown call
    await waitFor(() => killCode(pid) === 'ESRCH', 'the leftover process to be killed')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(session.submissions).toHaveLength(0) // a dead session gets no delivery
  })

  it('fails quietly when the session refuses the delivery', async () => {
    const { start, session } = setup()
    session.refuse = true // the conversation was aborted in the meantime
    started(await start.execute({ command: 'echo ok' }, undefined, {}))
    await waitFor(() => session.attempts === 1, 'the delivery attempt')
    expect(session.submissions).toHaveLength(0) // refused, and no unhandled rejection crashed the test
  })

  it('marks a timed-out task', async () => {
    const { start, session } = setup()
    const { pid } = started(await start.execute({ command: 'sleep 30', timeout_ms: 300 }, undefined, {}))
    await waitFor(() => session.submissions.length === 1, 'the timed-out result message')
    expect(session.submissions[0]!.content).toContain('timed out')
    expect(killCode(pid)).toBe('ESRCH')
  })

  it('reports unknown ids and lists the running ones', async () => {
    const { start, stop, list } = setup()
    const { id, pid } = started(await start.execute({ command: 'sleep 30' }, undefined, {}))
    const unknown = await stop.execute({ id: 'bg-999' }, undefined, {}) as { isError: boolean; output: { text: string }[] }
    expect(unknown.isError).toBe(true)
    expect(unknown.output[0]!.text).toContain('bg-999')
    expect(unknown.output[0]!.text).toContain(id)
    const listed = await list.execute({}, undefined, {}) as { output: { text: string }[] }
    expect(listed.output[0]!.text).toContain(id)
    expect(listed.output[0]!.text).toContain('sleep 30')
    expect(pid).toBeGreaterThan(0)
  })
})
