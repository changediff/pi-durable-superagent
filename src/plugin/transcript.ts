/**
 * Transcript readers shared by the worker and its watchdog: the newest assistant text of a
 * conversation (a turn's result), and the compact recent-activity rendering the watchdog prompts
 * with. Kept free of domain imports so both `worker.ts` and `watchdog.ts` can use it without cycles.
 */
import { AssistantEntry, ToolResultEntry, UserEntry, type ConversationId, type EntryRecord } from '@earendil-works/pi-durable'
import type { ContextView } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord/context'

/** The one runtime operation the transcript readers need: a conversation's committed context view. */
export interface ContextReader {
  context(conversationId: ConversationId, context: Context): Promise<ContextView>
}

const isUser = (entry: EntryRecord): boolean =>
  (typeof UserEntry?.is === 'function' && UserEntry.is(entry)) || entry.kind === 'pi.user'
const isAssistant = (entry: EntryRecord): boolean =>
  (typeof AssistantEntry?.is === 'function' && AssistantEntry.is(entry)) || entry.kind === 'pi.assistant'
const isToolResult = (entry: EntryRecord): boolean =>
  (typeof ToolResultEntry?.is === 'function' && ToolResultEntry.is(entry)) || entry.kind === 'pi.toolResult'

/** The newest non-empty assistant text of a conversation: a worker turn's result, a watchdog judgement. */
export async function lastAssistantText(reader: ContextReader, conversationId: ConversationId, context: Context): Promise<string> {
  const view = await reader.context(conversationId, context)
  for (const entry of [...view.entries].reverse()) {
    if (!isAssistant(entry)) continue
    const message = ((entry as { model?: unknown[] }).model ?? [])[0] as { content?: { type: string; text?: string }[] }
    const text = (message?.content ?? []).filter(part => part?.type === 'text').map(part => part.text ?? '').join('')
    if (text.trim()) return text.trim()
  }
  return ''
}

/** How many recent activity lines the watchdog prompt carries; the whole transcript never enters it. */
export const WATCHDOG_ACTIVITY_LIMIT = 16

const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? content.filter((part): part is { type: 'text'; text: string } => !!part && (part as { type?: string }).type === 'text')
        .map(part => part.text).join('')
    : ''

const truncate = (text: string, limit: number): string => {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length <= limit ? one : `${one.slice(0, limit)}…`
}

/** One compact line per transcript entry the watchdog can reason over; bookkeeping entries are skipped. */
export function activityLine(entry: EntryRecord): string {
  if (isUser(entry)) {
    const message = ((entry as { model?: unknown[] }).model ?? [])[0] as { content?: unknown }
    const text = typeof message?.content === 'string' ? message.content : textOf(message?.content)
    return text.trim() ? `用户：${truncate(text, 200)}` : ''
  }
  if (isAssistant(entry)) {
    const message = ((entry as { model?: unknown[] }).model ?? [])[0] as { content?: unknown[] }
    const parts = (message?.content ?? []) as { type: string; text?: string; name?: string; arguments?: unknown }[]
    const described = parts.map(part => {
      if (part?.type === 'text' && part.text?.trim()) return `说：${truncate(part.text, 160)}`
      if (part?.type === 'toolCall') return `调用工具 ${part.name}(${truncate(JSON.stringify(part.arguments ?? {}), 100)})`
      return ''
    }).filter(Boolean)
    return described.length ? `助手：${described.join('；')}` : ''
  }
  if (isToolResult(entry)) {
    const message = ((entry as { model?: unknown[] }).model ?? [])[0] as { toolName?: string; isError?: boolean; content?: unknown }
    const text = textOf(message?.content)
    const outcome = message?.isError ? '（出错）' : ''
    return `工具结果${outcome}${message?.toolName ? ` ${message.toolName}` : ''}：${truncate(text, 160)}`
  }
  return ''
}

/** The newest `limit` activity lines of a conversation, oldest first — the watchdog's whole view of the worker. */
export function activityLines(view: Pick<ContextView, 'entries'>, limit = WATCHDOG_ACTIVITY_LIMIT): string[] {
  const lines: string[] = []
  for (const entry of view.entries) {
    const line = activityLine(entry)
    if (line) lines.push(line)
  }
  return lines.slice(-limit)
}
