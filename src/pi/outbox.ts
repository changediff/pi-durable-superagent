/**
 * Durable outbox: receipts in SQLite, delivery retried through the shared Effects queue.
 * Mirrors `src/app/outbox.ts` without the DSH SourceRegistry indirection: there is exactly one channel,
 * Feishu, so delivery calls its sender directly.
 */
import type { OutboundMessage, Outbox as OutboxPort, ReplyStatus } from '../core/index.ts'
import { FAILURES_BEFORE_ERROR, Later, type Effects } from '../app/effects.ts'
import type { Store } from '../app/store.ts'
import type { ChannelPort } from './channel.ts'
export interface OutboxHost {
  readonly store: Pick<Store, 'atomic' | 'receipts'>
  readonly effects: Pick<Effects, 'enqueue' | 'cancel' | 'handle' | 'idle'>
  readonly channel: ChannelPort
  paused(): boolean
  log(message: string, detail?: unknown): void
}

export class FeishuOutbox implements OutboxPort {
  constructor(private readonly host: OutboxHost) {
    host.effects.handle('reply', (_payload, id) => this.deliver(id), { limit: () => host.paused() ? 0 : 1, retry: [3000, 120_000] })
  }

  send(message: OutboundMessage): void {
    const { store, effects, log } = this.host
    const added = store.atomic(() => { const ok = store.receipts.add(message); if (ok) effects.enqueue('reply', message.id, {}); return ok })
    log('outbox queued', { id: message.id, kind: message.kind, added, chat: message.channel.address.chatId })
  }

  status(id: string): ReplyStatus | undefined {
    return this.host.store.receipts.get(id)?.status
  }

  withdraw(id: string): void {
    const { store, effects } = this.host
    store.atomic(() => { if (store.receipts.withdraw(id)) effects.cancel('reply', id) })
  }

  sent(): Promise<void> {
    return this.host.effects.idle('reply')
  }

  private async deliver(id: string): Promise<void> {
    const { store, channel, log } = this.host
    const receipt = store.receipts.get(id)
    if (receipt?.status !== 'pending') return
    // Hold later messages for the same ticket and conversation behind an earlier pending one until it fails repeatedly.
    if (store.receipts.behind(id, FAILURES_BEFORE_ERROR)) throw new Later('An earlier message of this ticket to this conversation waits')
    log('outbox delivering', { id: receipt.id, chat: receipt.channel.address.chatId })
    const result = await channel.send(receipt)
    if (result === 'waiting') {
      log('outbox delivery deferred', receipt.id)
      throw new Later('Feishu is not reachable right now')
    }
    store.receipts.settle(receipt, result === 'gone' ? 'channelGone' : 'sent')
  }
}
