/**
 * A2A server channel: an HTTP JSON-RPC 2.0 endpoint other agents (Hermes peers) call to hand
 * work to this super-agent, plus the agent-card discovery document. Inbound messages become
 * Triggers like the Feishu source's; the plugin's replies come back through `send()` and are
 * held as A2A Task records the caller can poll with `tasks/get` if it times out.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import type { ChannelRef, OutboundMessage, Trigger } from '../core/index.ts'
import type { ScopeResult } from '../core/index.ts'
import type { ChannelPort } from './channel.ts'
import type { ResolvedSuperagentA2AConfig } from '../plugin/config.ts'

const SOURCE = 'a2a'
const MAX_BODY = 1024 * 1024
const WORKING_HINT = '已受理，仍在执行，请稍后用 tasks/get 按 id 查询'

export interface A2AHost {
  /** Called for every admissible A2A message; the runtime stores it as a Trigger. */
  onTrigger(trigger: Trigger): void
  log(message: string, detail?: unknown): void
}

interface TaskRecord {
  id: string
  contextId: string
  status: { state: string; timestamp: string; message?: TaskMessage }
  artifacts?: { artifactId: string; parts: { kind: string; text: string }[] }[]
}

interface TaskMessage {
  role: string
  messageId: string
  contextId: string
  parts: { kind: string; text: string }[]
}

interface Pending {
  resolve: (text: string) => void
  timer: NodeJS.Timeout
}

const hexId = (): string => randomUUID().replace(/-/g, '').slice(0, 24)

/** Constant-time Bearer token comparison: compare lengths first so timingSafeEqual never throws. */
function bearerMatches(authorization: string | undefined, token: string): boolean {
  if (authorization?.length !== `Bearer ${token}`.length) return false
  return authorization.startsWith('Bearer ') && timingSafeEqual(Buffer.from(authorization), Buffer.from(`Bearer ${token}`))
}

/** Concatenate the `text` fields of a SendMessage message's parts (v1.0 `kind` and legacy `type`). */
export function extractText(message: unknown): string {
  const parts = (message as { parts?: unknown[] })?.parts
  if (!Array.isArray(parts)) return ''
  return parts
    .map(part => String((part as { text?: unknown })?.text ?? ''))
    .filter(text => text.length > 0)
    .join('\n')
    .trim()
}

export class A2AChannel implements ChannelPort {
  private server?: Server
  private readonly pending = new Map<string, Pending>()
  private readonly tasks = new Map<string, TaskRecord>()
  private warnedOpen = false
  private readonly waitMs: number

  constructor(private readonly cfg: ResolvedSuperagentA2AConfig, private readonly host: A2AHost) {
    this.waitMs = cfg.waitMs
  }

  async start(): Promise<void> {
    const server = createServer((req, res) => { void this.handle(req, res) })
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.cfg.port, '0.0.0.0', () => resolve())
    })
    this.host.log('a2a listening', { port: this.cfg.port, url: this.cfg.publicUrl })
  }

  async stop(): Promise<void> {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve('')
      this.pending.delete(id)
    }
    await new Promise<void>(resolve => {
      if (!this.server) return resolve()
      this.server.close(() => resolve())
    })
  }

  async send(message: OutboundMessage): Promise<'sent' | 'gone' | 'waiting'> {
    if (message.channel.source !== SOURCE) {
      this.host.log('a2a send failed: not an a2a message', { source: message.channel.source, id: message.id })
      return 'waiting'
    }
    const taskId = message.channel.address.messageId ?? ''
    const task = this.tasks.get(taskId)
    const entry = this.pending.get(taskId)
    if (!entry && !task) return 'gone'
    if (message.kind !== 'reply') {
      // An acknowledgement (or notice) only reports progress: keep the pending promise waiting so
      // the SendMessage HTTP response resolves on the final reply, and surface it via tasks/get.
      if (task) {
        task.status = {
          state: 'TASK_STATE_WORKING',
          timestamp: new Date().toISOString(),
          message: { role: 'ROLE_AGENT', messageId: hexId(), contextId: task.contextId, parts: [{ kind: 'text', text: message.text ?? '' }] },
        }
      }
      return 'sent'
    }
    if (entry) {
      clearTimeout(entry.timer)
      this.pending.delete(taskId)
      entry.resolve(message.text ?? '')
    }
    if (task) {
      task.status = {
        state: 'TASK_STATE_COMPLETED',
        timestamp: new Date().toISOString(),
        message: { role: 'ROLE_AGENT', messageId: hexId(), contextId: task.contextId, parts: [{ kind: 'text', text: message.text ?? '' }] },
      }
      task.artifacts = [{ artifactId: hexId(), parts: [{ kind: 'text', text: message.text ?? '' }] }]
    }
    return 'sent'
  }

  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult {
    if (input.source === SOURCE) return { listened: true, observed: false, row: 'a2a' }
    return { listened: false, reason: 'not a2a source' }
  }

  private agentCard(): Record<string, unknown> {
    const url = this.cfg.publicUrl
    return {
      name: 'cc2-pi',
      description: 'pi-durable 超级智能体（coding + 主机运维），A2A 入口',
      url,
      version: '1.0.0',
      provider: { organization: 'pi-durable', url },
      supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
      capabilities: { streaming: false, pushNotifications: false },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [{ id: 'superagent', name: '超级智能体', description: 'CodingTools 编程/主机运维任务', tags: ['coding', 'ops'] }],
    }
  }

  /** The configured peer name whose token matches the bearer, or the default peer name. */
  private peerName(authorization: string | undefined): string {
    if (authorization?.startsWith('Bearer ')) {
      const token = authorization.slice('Bearer '.length)
      const peer = this.cfg.peers.find(candidate => candidate.token && candidate.token === token)
      if (peer) return peer.name
    }
    return 'a2a-peer'
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const path = req.url?.split('?')[0] ?? '/'
      if (req.method === 'GET' && (path === '/.well-known/agent-card.json' || path === '/.well-known/agent.json')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(this.agentCard()))
        return
      }
      if (req.method === 'POST' && (path === '/' || path === '/a2a/v1')) {
        const body = await readBody(req)
        let rpc: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }
        try {
          rpc = JSON.parse(body) as typeof rpc
        } catch {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }))
          return
        }
        const id = rpc.id ?? null
        if (this.cfg.token && !bearerMatches(req.headers.authorization, this.cfg.token)) {
          reply(res, id, { error: { code: -32050, message: 'unauthorized' } })
          return
        }
        if (!this.cfg.token && !this.warnedOpen) {
          this.warnedOpen = true
          this.host.log('a2a warning: SUP_A2A_TOKEN empty; accepting unauthenticated calls (tailnet-only deployment)')
        }
        const method = rpc.method ?? ''
        const params = rpc.params ?? {}
        if (method === 'SendMessage' || method === 'message/send') {
          const result = await this.onSendMessage(params, this.peerName(req.headers.authorization))
          reply(res, id, result.error ? result : { result: { task: result.task } })
          return
        }
        if (method === 'GetTask' || method === 'tasks/get') {
          const taskId = String(params.id ?? params.taskId ?? '')
          const task = this.tasks.get(taskId)
          if (!task) { reply(res, id, { error: { code: -32001, message: 'task not found' } }); return }
          reply(res, id, { result: { task } })
          return
        }
        reply(res, id, { error: { code: -32601, message: `method not found: ${method}` } })
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    } catch (error) {
      this.host.log('a2a request failed', String((error as { message?: string })?.message ?? error))
      if (!res.headersSent) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'internal error' } }))
      } else res.end()
    }
  }

  private async onSendMessage(params: Record<string, unknown>, peerName: string): Promise<{ task?: TaskRecord; error?: { code: number; message: string } }> {
    const message = params.message
    const text = extractText(message)
    if (!text) return { error: { code: -32602, message: 'empty text' } }
    const taskId = `task-${hexId()}`
    const contextId = String((message as { contextId?: unknown })?.contextId ?? '') || `ctx-${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const channel: ChannelRef = { source: SOURCE, thread: contextId, address: { chatId: contextId, messageId: taskId } }
    const trigger: Trigger = {
      id: `a2a-${taskId}`,
      source: SOURCE,
      threads: [{ source: SOURCE, id: contextId }],
      actor: { source: SOURCE, id: peerName },
      human: true,
      addressed: 'direct',
      at: new Date().toISOString(),
      text,
      channel,
      meta: { chatId: contextId, chatType: 'p2p', mentioned: false, messageId: taskId },
    }
    const task: TaskRecord = {
      id: taskId,
      contextId,
      status: { state: 'TASK_STATE_WORKING', timestamp: new Date().toISOString() },
    }
    this.tasks.set(taskId, task)
    const waiter = new Promise<string>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(taskId)
        resolve('')
      }, this.waitMs)
      this.pending.set(taskId, { resolve, timer })
    })
    this.host.onTrigger(trigger)
    const replyText = await waiter
    if (replyText) {
      task.status = {
        state: 'TASK_STATE_COMPLETED',
        timestamp: new Date().toISOString(),
        message: { role: 'ROLE_AGENT', messageId: hexId(), contextId, parts: [{ kind: 'text', text: replyText }] },
      }
      task.artifacts = [{ artifactId: hexId(), parts: [{ kind: 'text', text: replyText }] }]
    } else if (task.status.state === 'TASK_STATE_WORKING') {
      task.status = {
        state: 'TASK_STATE_WORKING',
        timestamp: new Date().toISOString(),
        message: { role: 'ROLE_AGENT', messageId: hexId(), contextId, parts: [{ kind: 'text', text: WORKING_HINT }] },
      }
    }
    return { task }
  }
}

function reply(res: ServerResponse, id: unknown, payload: Record<string, unknown>): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }))
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
