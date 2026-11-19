#!/usr/bin/env node
/**
 * One-shot task runner for the pi-durable superagent container.
 *
 * The superagent image has no durable-send bridge, so nothing outside the container can hand pi a
 * task except Feishu. This opens a throwaway Harness on JSONL storage under /tmp, runs one
 * conversation with CodingTools + the configured model, prints the final answer, and exits.
 * Run it with cwd=/app so bare specifiers resolve against /app/node_modules:
 *
 *   docker exec -i -w /app -u 1001 -e PI_TASK="..." pi-agent \
 *     node --experimental-transform-types --no-warnings --input-type=module -e "$(cat deploy/pi-task.mjs)"
 *
 * Env: PI_TASK (required), PI_CWD (default /work), PI_MAX_SECONDS (default 1800).
 */
import { mkdirSync } from 'node:fs'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { AssistantEntry, Harness, createRegistry } from '@earendil-works/pi-durable'
import { CodingTools } from '@earendil-works/pi-durable/tools'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { openNodeJsonlStorage } from '@earendil-works/pi-durable/storage/jsonl/node'

const task = process.env.PI_TASK || ''
if (!task.trim()) {
  console.error('PI_TASK is required')
  process.exit(2)
}
const cwd = process.env.PI_CWD || '/work'
const maxSeconds = Number(process.env.PI_MAX_SECONDS || 1800)
const cfg = {
  provider: process.env.SUP_PROVIDER || 'zhipu',
  model: process.env.SUP_MODEL || 'glm-5.3',
  workerModel: process.env.SUP_WORKER_MODEL || process.env.SUP_MODEL || 'glm-5.3',
  baseUrl: process.env.SUP_API_BASE || 'https://open.bigmodel.cn/api/coding/paas/v4',
  apiKeyEnv: process.env.SUP_API_KEY_ENV || 'ZHIPU_API_KEY',
  contextWindow: Number(process.env.SUP_CONTEXT_WINDOW || 200_000),
  maxTokens: Number(process.env.SUP_MAX_TOKENS || 32_768),
}
const { buildModels } = await import('/app/src/pi/models.ts')

const text = entry => (entry?.model ?? [])
  .flatMap(item => (item.content ?? []))
  .filter(part => part?.type === 'text')
  .map(part => part.text)
  .join('\n')
  .trim()

const dir = `/tmp/pi-task-${Date.now()}`
mkdirSync(dir, { recursive: true })
const registry = createRegistry()
registry.install(CodingTools)
const storage = await openNodeJsonlStorage(`${dir}/harness`, BACKGROUND_CONTEXT, { fsync: false })
const harness = await Harness.open(storage, {
  models: buildModels(cfg),
  registry,
  env: ({ cwd: target }) => new NodeExecutionEnv({ cwd: target || cwd }),
}, BACKGROUND_CONTEXT)
try {
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: cfg.provider, modelId: cfg.model } } })
  const submission = await root.submit({ type: 'input', content: task }, BACKGROUND_CONTEXT)
  const settled = await Promise.race([
    submission.wait(BACKGROUND_CONTEXT),
    new Promise(resolve => setTimeout(() => resolve({ status: 'timeout' }), maxSeconds * 1000)),
  ])
  if (settled.status !== 'done') {
    console.error('task did not finish:', JSON.stringify(settled).slice(0, 500))
    process.exitCode = 1
  } else {
    const answer = await root.commit(tx => tx.entry(AssistantEntry, settled.answer), BACKGROUND_CONTEXT)
    console.log(text(answer))
    await harness.close(BACKGROUND_CONTEXT).catch(() => {})
    process.exit(0)
  }
} finally {
  await harness.close(BACKGROUND_CONTEXT).catch(() => {})
}
