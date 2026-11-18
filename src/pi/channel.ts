/** Channel port: the one thing the runtime needs from an inbound/outbound surface. */
import type { OutboundMessage } from '../core/index.ts'
import type { ScopeResult } from '../core/index.ts'

export interface ChannelPort {
  /** Connect the inbound transport (Feishu WebSocket; a memory channel does nothing). */
  start?(): Promise<void>
  stop?(): Promise<void>
  /** Deliver a queued reply: `sent`, `gone` when the conversation can never receive it, `waiting` to retry. */
  send(message: OutboundMessage): Promise<'sent' | 'gone' | 'waiting'>
  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult
}

/** In-memory channel used by `--selftest`: accepts every direct message and records what the runtime sends. */
export class MemoryChannel implements ChannelPort {
  readonly sent: { text: string; kind: string }[] = []

  async send(message: OutboundMessage): Promise<'sent' | 'gone' | 'waiting'> {
    this.sent.push({ text: message.text, kind: message.kind })
    return 'sent'
  }

  scope(input: { source: string; meta: Record<string, unknown> }): ScopeResult {
    return input.meta.chatType === 'p2p' ? { listened: true, observed: false, row: 'direct' } : { listened: true, observed: true, row: 'group' }
  }
}
