/**
 * A2A client: call a peer agent (Hermes, cowagent) over the same JSON-RPC contract this
 * server exposes. Discovery goes through the peer's agent card; the call retries the
 * legacy `message/send` method when the peer rejects `SendMessage`.
 */
import { randomUUID } from 'node:crypto'

export interface A2APeerRef {
  name: string
  url: string
  token?: string
  timeout?: number
}

export interface A2APeerResult {
  text: string
  contextId: string
  state: string
}

interface AgentCard {
  url?: string
  supportedInterfaces?: { url?: string; protocolBinding?: string; transport?: string; protocolVersion?: string }[]
}

const fetchJson = async (url: string, init: RequestInit, timeoutMs: number): Promise<unknown> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    const body = await response.text()
    try {
      return JSON.parse(body) as unknown
    } catch {
      throw new Error(`a2a: non-JSON response (${response.status})`)
    }
  } finally {
    clearTimeout(timer)
  }
}

/** Pick the JSON-RPC endpoint from the peer's agent card, best effort. */
export async function peerEndpoint(peer: A2APeerRef, timeoutMs: number): Promise<string> {
  let card: AgentCard | undefined
  try {
    card = await fetchJson(`${peer.url.replace(/\/$/, '')}/.well-known/agent-card.json`, { method: 'GET' }, Math.min(timeoutMs, 5000)) as AgentCard
  } catch {
    card = undefined
  }
  const iface = (card?.supportedInterfaces ?? []).find(entry =>
    entry.protocolBinding === 'JSONRPC' || entry.transport === 'JSONRPC')
  if (iface?.url) return iface.url
  if (card?.url) return card.url
  return peer.url
}

export async function callPeer(peer: A2APeerRef, text: string, contextId?: string): Promise<A2APeerResult> {
  const timeoutMs = peer.timeout && peer.timeout > 0 ? peer.timeout * 1000 : 100_000
  const endpoint = await peerEndpoint(peer, timeoutMs)
  const ctx = contextId ?? `ctx-${randomUUID().replace(/-/g, '').slice(0, 16)}`
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (peer.token) headers.authorization = `Bearer ${peer.token}`
  const rpc = (method: string): string => JSON.stringify({
    jsonrpc: '2.0',
    id: randomUUID(),
    method,
    params: { message: { role: 'ROLE_USER', messageId: randomUUID(), contextId: ctx, parts: [{ kind: 'text', text }] } },
  })
  let response = await fetchJson(endpoint, { method: 'POST', headers, body: rpc('SendMessage') }, timeoutMs) as
    { error?: { code?: number; message?: string }; result?: Record<string, unknown> }
  if (response.error?.code === -32601) {
    response = await fetchJson(endpoint, { method: 'POST', headers, body: rpc('message/send') }, timeoutMs) as typeof response
  }
  if (response.error) throw new Error(`a2a ${peer.name}: ${response.error.message ?? 'error'}`)
  const result = response.result ?? {}
  const task = (result.task ?? result.message ?? result) as Record<string, unknown>
  const texts = (parts: unknown): string =>
    Array.isArray(parts) ? parts.map(part => String((part as { text?: unknown })?.text ?? '')).filter(Boolean).join('\n') : ''
  const artifacts = Array.isArray(task.artifacts)
    ? (task.artifacts as { parts?: unknown }[]).flatMap(entry => texts(entry.parts)).filter(Boolean).join('\n')
    : ''
  const status = (task.status ?? {}) as Record<string, unknown>
  const statusText = texts((status.message as { parts?: unknown } | undefined)?.parts)
  const ownText = texts(task.parts)
  const body = artifacts || statusText || ownText
  return {
    text: body,
    contextId: String(task.contextId ?? ctx),
    state: String(status.state ?? ''),
  }
}
// No CLI entry: this module is library-only; the plugin's `a2a_send` tool is the outbound surface.
