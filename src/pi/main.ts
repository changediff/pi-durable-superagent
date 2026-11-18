#!/usr/bin/env node
/**
 * Entry point of the pi-durable super-agent port.
 *
 *   node --experimental-transform-types src/pi/main.ts            # Feishu WebSocket server
 *   node --experimental-transform-types src/pi/main.ts --selftest # one synthetic message, memory channel
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Trigger } from '../core/index.ts'
import { loadConfig } from './config.ts'
import { MemoryChannel } from './channel.ts'
import { PiSuperagentRuntime } from './runtime.ts'

const log = (message: string, detail?: unknown): void => {
  const suffix = detail === undefined ? '' : ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`
  console.log(`[superagent ${new Date().toISOString()}] ${message}${suffix}`)
}

async function serve(): Promise<void> {
  const cfg = loadConfig()
  if (!cfg.feishuAppId || !cfg.feishuAppSecret) throw new Error('FEISHU_APP_ID / FEISHU_APP_SECRET are required')
  if (!process.env[cfg.apiKeyEnv]) throw new Error(`${cfg.apiKeyEnv} is required`)
  const runtime = new PiSuperagentRuntime(cfg, { log })
  await runtime.start()
  const shutdown = async (signal: string): Promise<void> => {
    log(`received ${signal}; stopping`)
    await runtime.stop().catch(error => log('stop failed', String(error)))
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

/** End-to-end smoke without Feishu: synthetic DM -> GLM assessor -> ticket -> durable worker -> recorded reply. */
async function selftest(): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'superagent-selftest-'))
  const cfg = loadConfig({
    ...process.env,
    SUP_STATE_DIR: join(base, 'state'),
    SUP_WORK_DIR: join(base, 'work'),
    SUP_HARNESS_DIR: join(base, 'harness'),
    SUP_ALLOW_ALL: '1',
    SUP_EVAL_MODE: 'auto',
  })
  const channel = new MemoryChannel()
  const runtime = new PiSuperagentRuntime(cfg, { channel, log })
  const started = Date.now()
  try {
    await runtime.start()
    const trigger: Trigger = {
      id: `fs-selftest-${started}`,
      source: 'feishu',
      threads: [{ source: 'feishu', id: 'selftest-chat:selftest-message' }],
      actor: { source: 'feishu', id: 'selftest-user' },
      human: true,
      addressed: 'direct',
      at: new Date().toISOString(),
      text: '请用一句话回答：1+1 等于几？回答格式：结果是 N。',
      channel: { source: 'feishu', thread: 'selftest-chat:selftest-message', address: { chatId: 'selftest-chat', messageId: 'selftest-message' } },
      meta: { chatId: 'selftest-chat', chatType: 'p2p', mentioned: false, messageId: 'selftest-message' },
    }
    runtime.inject(trigger)
    const deadline = Date.now() + 240_000
    const result = (): { text: string; kind: string } | undefined => channel.sent.find(item => item.kind === 'reply')
    while (!result() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 1000))
    const tickets = runtime.store.tickets.list()
    if (result()) {
      log('SELFTEST PASS', { seconds: Math.round((Date.now() - started) / 1000), tickets: tickets.length, acknowledgement: channel.sent[0]?.text, reply: result()!.text.slice(0, 300) })
      process.exitCode = 0
    } else {
      log('SELFTEST FAIL: no reply before the deadline', { tickets: tickets.map(ticket => ({ id: ticket.id, title: ticket.title, ended: ticket.ended })) })
      process.exitCode = 1
    }
  } finally {
    await runtime.stop().catch(() => {})
    if (process.env.SUP_KEEP_SELFTEST === '1') log('selftest dir kept', base)
    else await rm(base, { recursive: true, force: true }).catch(() => {})
  }
}

const run = process.argv.includes('--selftest') ? selftest : serve
run().catch(error => {
  log('fatal', String((error as Error)?.stack ?? error))
  process.exit(1)
})
