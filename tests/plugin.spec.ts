/** Plugin-level checks: the extension's shape, its section, and a real dispatch through a faux-model harness. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Harness, MemoryStorage, createRegistry } from '@earendil-works/pi-durable'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSuperagentExtension, SUPERAGENT_TOOLS, type SuperagentConfig } from '../src/plugin/index.ts'
import { settingsPolicy } from '../src/policy.ts'
import type { Thread, Trigger } from '../src/core/index.ts'
import { workerConversationKey } from '../src/plugin/worker.ts'

/** A fake channel: records what the plugin delivers, never Feishu. */
const sent: { text: string; kind: string }[] = []
let directory: string

const config = (): SuperagentConfig => ({
  stateDir: join(directory, 'state'),
  workDir: join(directory, 'work'),
  harnessDir: join(directory, 'harness'),
  maxWorkers: 1,
  evalMode: 'auto',
  router: { provider: 'faux', model: 'router-1' },
  worker: { provider: 'faux', model: 'worker-1' },
  channel: { send: async message => { sent.push({ text: message.text, kind: message.kind }); return 'sent' } },
  assessor: { baseUrl: 'http://127.0.0.1:9', apiKeyEnv: 'UNSET_FOR_TEST' },
  allowAll: true,
})

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'superagent-plugin-'))
  sent.length = 0
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('the superagent extension', () => {
  it('is named, installs into a registry, and exposes the documented tools', () => {
    const plugin = createSuperagentExtension(config())
    expect(plugin.name).toBe('superagent')
    expect(plugin.tools!.map(tool => tool.name).sort()).toEqual([...SUPERAGENT_TOOLS].sort())
    expect(plugin.tasks!.map(task => task.definition.name)).toContain('superagent.worker')
    expect(() => createRegistry().install(plugin)).not.toThrow()
  })

  it('renders a section that documents the tools and the worker language rule', async () => {
    const plugin = createSuperagentExtension(config())
    expect(plugin.sections).toHaveLength(1)
    const text = await plugin.sections![0]!.render({} as never, {} as never)
    for (const name of SUPERAGENT_TOOLS) expect(text).toContain(name)
    expect(text).toContain("follows the user's language")
  })
})

describe('trusted a2a sources and the policy gate', () => {
  const a2aScope = { scope: () => ({ listened: true as const, observed: false, row: 'a2a' }) }
  const a2aTrigger: Trigger = {
    id: 'a2a-1', source: 'a2a', threads: [{ source: 'a2a', id: 'ctx-1' }], actor: { source: 'a2a', id: 'hermes-peer' },
    human: true, addressed: 'direct', at: '2026-01-01T00:00:00.000Z', text: 'do something', meta: {},
  }
  const a2aThread: Thread = {
    key: 'a2a:ctx-1', ref: { source: 'a2a', id: 'ctx-1' }, createdAt: '2026-01-01T00:00:00.000Z',
    subscriptions: [], correlated: [], pending: [], meta: {},
  }

  it('seeds a trustedSources entry so an a2a Trigger passes the real policy gate', () => {
    const plugin = createSuperagentExtension({ ...config(), trustedSources: ['a2a'] })
    const settings = plugin.store.settings()
    expect(settings.policy.sources['a2a']).toMatchObject({ allowAll: true })
    const policy = settingsPolicy(settings, a2aScope)
    expect(policy.gate(a2aTrigger, a2aThread, [])).toMatchObject({ admissible: true, strength: 'explicit' })
  })

  it('refuses the same Trigger without a trustedSources entry (the old filtering bug)', () => {
    const plugin = createSuperagentExtension(config())
    const policy = settingsPolicy(plugin.store.settings(), a2aScope)
    expect(policy.gate(a2aTrigger, a2aThread, []).admissible).toBe(false)
  })

  it('backfills a missing trustedSource into an existing settings history without touching the rest', async () => {
    const stateDir = join(directory, 'state')
    const first = createSuperagentExtension({ ...config(), stateDir })
    expect(first.store.settings().policy.sources['a2a']).toBeUndefined()
    await first.stop()
    const logs: unknown[][] = []
    const second = createSuperagentExtension({ ...config(), stateDir, trustedSources: ['a2a'], log: (m, d) => logs.push([m, d]) })
    expect(second.store.settings().policy.sources['a2a']).toMatchObject({ allowAll: true })
    expect(logs.some(([m, d]) => m === 'settings backfilled trusted sources' && JSON.stringify(d) === '["a2a"]')).toBe(true)
    await second.stop()
  })
})

describe('superagent_dispatch through a real harness', () => {
  it('creates a Ticket in the domain store, launches a worker conversation, and acknowledges through the channel', async () => {
    const plugin = createSuperagentExtension(config())
    const registry = createRegistry()
    registry.install(plugin)
    const faux = fauxProvider({ models: [{ id: 'router-1' }, { id: 'worker-1' }] })
    const models = createModels()
    models.setProvider(faux.provider)
    const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT)
    try {
      plugin.bind(harness)
      await plugin.start()
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('superagent_dispatch', {
          title: 'Add a status badge',
          scope: 'Add a status badge to the README',
          text: 'please add a status badge to the README',
          actor: 'ou_test',
          acknowledgement: '收到，我去改',
        })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('dispatched'),
      ])
      const router = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: 'faux', modelId: 'router-1' } } })
      const submission = await router.submit({ type: 'input', content: 'please add a status badge to the README' }, BACKGROUND_CONTEXT)
      const settled = await submission.wait(BACKGROUND_CONTEXT)
      expect(settled.status).toBe('done')

      // The Ticket exists with the dispatched title, an accept decision, and a running assignment.
      const tickets = plugin.store.tickets.list()
      expect(tickets).toHaveLength(1)
      const ticket = tickets[0]!
      expect(ticket.title).toBe('Add a status badge')
      expect(ticket.mandate.scope).toBe('Add a status badge to the README')
      expect(ticket.assignments.at(-1)!.state).toMatch(/pending|running/)
      const decision = plugin.store.decisions.get(ticket.decisionId)
      expect(decision?.kind).toBe('accept')

      // The worker conversation was created by the durable worker task (task-owned, KV-recorded).
      await until(() => !!plugin.store.get(workerConversationKey(ticket.id)))
      expect(plugin.store.get(workerConversationKey(ticket.id))).toBeTypeOf('number')

      // The acknowledgement reached the fake channel; the faux worker (no responses queued) fails its turn,
      // which the task reports back through the Engine.
      await until(() => sent.some(item => item.kind === 'acknowledgement'))
      expect(sent.find(item => item.kind === 'acknowledgement')!.text).toBe('收到，我去改')
      await until(() => !!plugin.store.tickets.get(ticket.id)?.assignments.at(-1)?.report)
      expect(plugin.store.tickets.get(ticket.id)!.assignments.at(-1)!.report!.state).toBe('failed')

      // The status tool lists the ticket.
      const status = plugin.tools!.find(tool => tool.name === 'superagent_status')!
      const result = await status.execute({} as never, {} as never, {} as never)
      expect(JSON.stringify(result)).toContain(ticket.id)
    } finally {
      await plugin.stop().catch(() => {})
      await harness.close(BACKGROUND_CONTEXT).catch(() => {})
    }
  })
})

async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  expect(check()).toBe(true)
}
