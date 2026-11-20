/**
 * Feishu source for the pi-durable port: WebSocket long connection in, message replies out.
 *
 * The DSH build received Feishu events through a `lark-cli` shim and polled chat history. The port talks
 * to the same Feishu app directly with `@larksuiteoapi/node-sdk`, keeps one Thread per chat/topic root, and
 * returns every reply as a Feishu reply to the message that started the ticket (falling back to a chat
 * message when the original was recalled).
 */
import * as lark from '@larksuiteoapi/node-sdk'
import type { ChannelRef, OutboundMessage, Trigger } from '../core/index.ts'
import type { ScopeResult, SourceScope } from '../core/index.ts'
import type { Config } from './config.ts'
import { FEISHU_ENVELOPE_MAX_BYTES, chunkFeishuText, renderFeishuMessage } from './feishu-format.ts'

const SOURCE = 'feishu'

export interface FeishuHost {
  /** Called for every admissible chat message; the runtime stores it as a Trigger. */
  onTrigger(trigger: Trigger): void
  log(message: string, detail?: unknown): void
}

/** Feishu thread identity: conversation-level for p2p and plain chats, per topic thread otherwise. */
export const feishuThreadId = (chatId: string, rootId: string | undefined, messageId: string): string =>
  `${chatId}:${rootId ?? "chat"}`

export type MessageEvent = {
  sender: { sender_id?: { open_id?: string }; sender_type?: string }
  message: {
    message_id: string; chat_id: string; chat_type?: string; message_type: string; content: string
    mentions?: { key?: string; name?: string; id?: { open_id?: string } }[]
    root_id?: string; parent_id?: string; thread_id?: string; create_time?: string
  }
}

/** Plain text of a Feishu text or rich-text (post) message; other types are summarized. */
export function messageText(message: MessageEvent['message']): string {
  let content: unknown
  try { content = JSON.parse(message.content) } catch { return `[${message.message_type} 消息]` }
  if (message.message_type === 'text') return String((content as { text?: string }).text ?? '')
  if (message.message_type === 'post') {
    const body = (content as { zh_cn?: { content?: { tag: string; text?: string }[][] } }).zh_cn ?? (content as { en_us?: { content?: { tag: string; text?: string }[][] } }).en_us
    const lines = (body?.content ?? []).map(line => line.map(node => node.text ?? '').join(''))
    return lines.join('\n').trim()
  }
  if (message.message_type === 'image') return '[图片消息]'
  if (message.message_type === 'file') return '[文件消息]'
  return `[${message.message_type} 消息]`
}

export class FeishuSource implements SourceScope {
  readonly kind = SOURCE
  private readonly client: lark.Client
  private readonly ws: lark.WSClient
  private readonly dispatcher: lark.EventDispatcher
  private stopped = false

  constructor(private readonly cfg: Config, private readonly host: FeishuHost) {
    const domain = cfg.feishuDomain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu
    this.client = new lark.Client({ appId: cfg.feishuAppId, appSecret: cfg.feishuAppSecret, domain })
    this.ws = new lark.WSClient({ appId: cfg.feishuAppId, appSecret: cfg.feishuAppSecret, domain })
    this.dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: MessageEvent) => this.receive(data),
    })
  }

  async start(): Promise<void> {
    await this.ws.start({ eventDispatcher: this.dispatcher })
    this.host.log('feishu ws connected')
  }

  async stop(): Promise<void> {
    // lark's WSClient has no stop(); the flag makes late events no-ops and the process exit closes the socket.
    this.stopped = true
  }

  /** A chat is listened to when it is a direct message, the bot is mentioned, or all chats are enabled. */
  scope({ meta }: { source: string; meta: Record<string, unknown> }): ScopeResult {
    if (meta.chatType === 'p2p') return { listened: true, observed: false, row: 'direct' }
    if (meta.mentioned === true) return { listened: true, observed: this.cfg.listenAllChats, row: 'group' }
    if (this.cfg.listenAllChats) return { listened: true, observed: true, row: 'group' }
    return { listened: false, reason: 'no_mention' }
  }

  /** Deliver an acknowledgement or result: reply to the originating message, else post into the chat. */
  async send(message: OutboundMessage): Promise<'sent' | 'gone' | 'waiting'> {
    const chatId = message.channel.address.chatId
    const messageId = message.channel.address.messageId
    const mode = this.cfg.feishuRenderMode
    const render = (chunk: string) => renderFeishuMessage(chunk, mode)
    // Chunks are measured through the real envelope: wrappers, JSON escapes and UTF-8 all count.
    const chunks = chunkFeishuText(message.text ?? '', { charLimit: this.cfg.feishuChunkLimit, byteLimit: FEISHU_ENVELOPE_MAX_BYTES }, chunk => render(chunk).content)
    for (const chunk of chunks.length > 0 ? chunks : ['']) {
      const { msgType, content } = render(chunk)
      try {
        if (messageId) {
          await this.client.im.message.reply({ path: { message_id: messageId }, data: { content, msg_type: msgType } })
        } else if (chatId) {
          await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: msgType, content } })
        } else {
          return 'gone'
        }
      } catch (error) {
        const detail = String((error as { message?: string })?.message ?? error)
        if (/recall|deleted|not\s*found|invalid\s*message/i.test(detail)) {
          if (chatId) {
            await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: chatId, msg_type: msgType, content } })
            continue
          }
          return 'gone'
        }
        this.host.log('feishu send failed', detail)
        return 'waiting'
      }
    }
    const rendered = (chunks.length > 0 ? chunks : ['']).map(chunk => render(chunk))
    const bytes = rendered.reduce((sum, item) => sum + Buffer.byteLength(item.content, 'utf8'), 0)
    const types = [...new Set(rendered.map(item => item.msgType))]
    this.host.log('feishu send', { msgType: types.join('+'), bytes, chunks: rendered.length })
    return 'sent'
  }

  private receive(data: MessageEvent): void {
    if (this.stopped) return
    const message = data.message
    const senderType = data.sender?.sender_type ?? 'user'
    const openId = data.sender?.sender_id?.open_id ?? ''
    if (senderType !== 'user' || !openId) return // Bots and system senders never originate work.
    const mentioned = (message.mentions ?? []).length > 0
    const chatType = message.chat_type ?? (message.chat_id.startsWith('oc_') ? 'group' : 'p2p')
    const threadId = feishuThreadId(message.chat_id, message.thread_id ?? message.root_id, message.message_id)
    const at = message.create_time && /^\d+$/.test(message.create_time)
      ? new Date(Number(message.create_time)).toISOString()
      : new Date().toISOString()
    const channel: ChannelRef = { source: SOURCE, thread: threadId, address: { chatId: message.chat_id, messageId: message.message_id } }
    const trigger: Trigger = {
      id: `fs-${message.message_id}`,
      source: SOURCE,
      threads: [{ source: SOURCE, id: threadId }],
      actor: { source: SOURCE, id: openId },
      human: true,
      ...(chatType === 'p2p' ? { addressed: 'direct' as const } : mentioned ? { addressed: 'mention' as const } : {}),
      at,
      text: messageText(message),
      channel,
      meta: {
        chatId: message.chat_id, chatType, mentioned, messageId: message.message_id,
        ...(message.root_id ? { rootId: message.root_id } : {}),
        ...(message.thread_id ? { threadId: message.thread_id } : {}),
      },
    }
    this.host.onTrigger(trigger)
  }
}
