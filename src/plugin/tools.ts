/**
 * The plugin's tool surface: what a Router conversation (and, for `superagent_report`, a worker
 * conversation) sees. `superagent_dispatch` is the tool-equivalent of the Feishu ingest path: it
 * stores a Trigger, records an accept decision (the domain still owns the gate and the Mandate),
 * and the Engine's executor callback launches the worker task inside the very call.
 */
import { defineTool } from '@earendil-works/pi-durable'
import type { ToolExecutionApi } from '@earendil-works/pi-durable'
import { arr, obj, oneOf, opt, str } from '@earendil-works/pi-schema'
import { UserError, type Engine, type Trigger } from '../core/index.ts'
import { callPeer } from '../pi/a2a-client.ts'
import type { Store } from '../app/store.ts'
import type { ResolvedSuperagentConfig } from './config.ts'
import type { PluginExecutor } from './executor.ts'
import type { WorkerBridges } from './worker.ts'

export interface ToolDeps {
  readonly store: Store
  readonly cfg: ResolvedSuperagentConfig
  engine(): Engine
  executor: PluginExecutor
  bridges: WorkerBridges
}

export const SUPERAGENT_TOOLS = ['superagent_dispatch', 'superagent_status', 'superagent_cancel', 'superagent_report', 'a2a_send', 'recall', 'device'] as const

/** The system prompt section that documents the surface (rendered into every conversation selecting the extension). */
export const SUPERAGENT_SECTION = `You are connected to the super-agent (超级智能体) Router surface.

- superagent_dispatch: accept a person's request and start a worker ticket. Give a short title, a one-line delivery scope, the requesting message text, and the actor id (plus the channel reference when you have one). It creates a Ticket, sends the acknowledgement, starts a durable worker conversation, and returns the ticket id.
- superagent_status: list open and ended tickets with their assignment state and last worker report.
- superagent_cancel: stop a ticket's worker (the domain ends the ticket; no result is delivered).
- superagent_report: worker-side only. A worker conversation reports its state (ready, blocked, failed, ...) with a summary; workers call it when they cannot finish, or to report completion early.
- a2a_send: call another A2A agent (peer) by its configured name and return its answer text. Peers come from the plugin's a2a.peers configuration; an unknown peer or a failed call returns an error message instead of throwing.
- recall: fetch one stored object by id — kind: trigger | thread | ticket | conversation | outbox — as a bounded view with a short summary and 'next' hops to walk the reference graph (trigger → its threads and tickets; thread → its tickets and recent triggers; ticket → its threads, worker conversation, replies; conversation → its ticket and recent entry summaries; outbox → its ticket and thread). Long fields are inlined head+tail only; pass the cursor shown in the view (e.g. "text:0") to page through the full text. Read-only.
- device: hand one prompt to an online BYOM device (a person's local agent CLI) and return its result text. The task executes entirely on the device, with its own files and model credentials. If no device is online it fails at once; if the wait times out the assignment keeps running there and the text carries its assignmentId.

Workers run in their own conversations with coding tools and do the actual work; their final message is delivered back verbatim. Reply and worker language follows the user's language (中文请求用中文回复).`

const DISPATCH = 'superagent_dispatch'
const STATUS = 'superagent_status'
const CANCEL = 'superagent_cancel'
const REPORT = 'superagent_report'
const A2A_SEND = 'a2a_send'

export interface DispatchArgs {
  title: string
  scope: string
  text: string
  actor: string
  source?: string
  thread?: string
  chatId?: string
  messageId?: string
  acknowledgement?: string
}

/** Create the four super-agent tools against one plugin instance. */
export function createSuperagentTools(deps: ToolDeps) {
  const dispatch = defineTool({
    name: DISPATCH,
    description: 'Accept a request and start a worker ticket: creates a Ticket, acknowledges, and launches a durable worker conversation. Returns the ticket id.',
    parameters: obj({
      title: str({ description: 'Short ticket title (<= 40 chars)' }),
      scope: str({ description: 'One-line statement of what the worker must deliver, with target and acceptance' }),
      text: str({ description: 'The requesting message text, as the person wrote it' }),
      actor: str({ description: "The requester's actor id on the source (e.g. a Feishu open_id)" }),
      source: opt(str({ description: 'Source name; defaults to the configured source' })),
      thread: opt(str({ description: 'Thread id the request belongs to; defaults to the chat id or a per-actor thread' })),
      chatId: opt(str({ description: 'Channel chat id for replies (e.g. Feishu chat_id)' })),
      messageId: opt(str({ description: 'Channel message id to reply to' })),
      acknowledgement: opt(str({ description: 'Short acknowledgement sent back to the channel (10-20 chars)' })),
    }),
    structuredOutputSchema: obj({ ticketId: str() }),
    execute: async (args: DispatchArgs, api: ToolExecutionApi<never>, context) => {
      const trigger = dispatchTrigger(deps, args, api)
      const received = deps.engine().receive(trigger)
      if (received === 'filtered') throw new UserError('notAdmissible', { reason: 'source scope refused the trigger' })
      const decision = deps.engine().decide(trigger.id, {
        kind: 'accept',
        title: args.title.slice(0, 80),
        scope: args.scope.slice(0, 500),
        reason: 'superagent_dispatch',
        ...(args.acknowledgement ? { acknowledgement: args.acknowledgement.slice(0, 120) } : {}),
        audit: { router: DISPATCH },
      })
      // The decide() above queued the assignment; wait for the durable worker task to be created
      // before returning, so the ticket id the model relays is already backed by a task.
      await deps.executor.drain(context)
      const ticketId = decision.ticketId!
      return {
        output: [{ type: 'text', text: `Ticket ${ticketId}「${args.title}」dispatched; the worker's final message will be delivered to the channel.` }],
        structuredOutput: { ticketId },
      }
    },
  })

  const status = defineTool({
    name: STATUS,
    description: 'List super-agent tickets with their state (open/ended), assignment state and last worker report.',
    parameters: obj({
      ticketIds: opt(arr(str(), { description: 'Only these tickets; default: the newest 30' })),
    }),
    execute: async args => {
      const all = deps.store.tickets.list()
      const selected = args.ticketIds?.length ? all.filter(ticket => args.ticketIds!.includes(ticket.id)) : all.slice(0, 30)
      if (!selected.length) return { output: [{ type: 'text', text: 'No tickets.' }] }
      const lines = selected.map(ticket => {
        const assignment = ticket.assignments.at(-1)
        const report = assignment?.report
        const state = ticket.ended ? `ended (${ticket.ended.by}/${ticket.ended.outcome})` : 'open'
        const last = report ? `last report ${report.state}: ${report.summary.slice(0, 160)}` : 'no report yet'
        return `${ticket.id} ${state} assignment=${assignment?.state ?? 'none'} 「${ticket.title}」 ${last}`
      })
      return { output: [{ type: 'text', text: lines.join('\n') }] }
    },
  })

  const cancel = defineTool({
    name: CANCEL,
    description: "Stop a ticket's worker: the domain ends the ticket and withdraws its mandate; no result is delivered.",
    parameters: obj({
      ticketId: str({ description: 'The ticket to stop' }),
      reason: opt(str({ description: 'Why, for the record' })),
    }),
    execute: async args => {
      try {
        deps.engine().stopTicket(args.ticketId, args.reason)
        return { output: [{ type: 'text', text: `Ticket ${args.ticketId} stopped.` }] }
      } catch (error) {
        return refusal(error)
      }
    },
  })

  const report = defineTool({
    name: REPORT,
    description: "Worker-side: report this ticket's state (ready/blocked/failed/...) with a summary. Call it when you cannot finish, or to hand back an early result.",
    parameters: obj({
      state: oneOf(['ready', 'blocked', 'failed', 'progress', 'waiting', 'dropped'], { description: 'The worker state to report' }),
      summary: str({ description: 'What happened, concise; for ready, the result to deliver' }),
      question: opt(str({ description: 'Open question for a person (blocked/failed)' })),
    }),
    execute: async (args, api) => {
      const ticketId = deps.bridges.ticketOf(api.conversationId)
      if (!ticketId) {
        return { isError: true, output: [{ type: 'text', text: 'This conversation is not a running worker; superagent_report is a worker-side tool.' }] }
      }
      try {
        deps.engine().report(ticketId, { state: args.state, summary: args.summary.slice(0, 1000), ...('question' in args && args.question !== undefined ? { question: args.question } : {}) })
        // A ready report ends the ticket, which stops this worker's turn before its final message could be
        // sent: the tool delivers the result itself. The outbox dedupes if the turn later sends the same text.
        if (args.state === 'ready') {
          try { deps.engine().reply({ purpose: 'result', ticketId, text: args.summary.slice(0, 4000) }) }
          catch (error) { deps.cfg.log('report reply refused', String((error as Error)?.message ?? error)) }
        }
        return { output: [{ type: 'text', text: `Reported ${args.state} on ${ticketId}.` }] }
      } catch (error) {
        return refusal(error)
      }
    },
  })

  const a2aSend = defineTool({
    name: A2A_SEND,
    description: '调用另一个 A2A agent（peer），返回它的回答文本。peer 名字来自插件配置 a2a.peers。',
    parameters: obj({
      peer: str({ description: 'Peer name as configured in a2a.peers (e.g. "hermes")' }),
      text: str({ description: 'The message text to send to the peer agent' }),
      context: opt(str({ description: 'A2A context id to continue a prior conversation; omit to start a new one' })),
    }),
    execute: async args => {
      const peers = deps.cfg.a2a.peers
      const peer = peers.find(candidate => candidate.name === args.peer)
      if (!peer) {
        const known = peers.length ? peers.map(candidate => candidate.name).join(', ') : '(none configured)'
        return { isError: true, output: [{ type: 'text', text: `a2a_send: unknown peer "${args.peer}"; configured peers: ${known}` }] }
      }
      try {
        const result = await callPeer(peer, args.text, args.context)
        return { output: [{ type: 'text', text: result.text || `(peer "${peer.name}" returned no text; task state ${result.state || 'unknown'})` }] }
      } catch (error) {
        return { isError: true, output: [{ type: 'text', text: `a2a_send: calling peer "${peer.name}" failed: ${String((error as Error)?.message ?? error)}` }] }
      }
    },
  })

  return [dispatch, status, cancel, report, a2aSend]
}

/** The Trigger a dispatch records: a direct, human request on the caller's channel. */
function dispatchTrigger(deps: ToolDeps, args: DispatchArgs, api: ToolExecutionApi<never>): Trigger {
  const source = args.source ?? deps.cfg.source
  const thread = args.thread ?? args.chatId ?? `dm-${args.actor}`
  const address: Record<string, string> = {}
  if (args.chatId) address.chatId = args.chatId
  if (args.messageId) address.messageId = args.messageId
  return {
    id: `sa-${api.callId}`,
    source,
    threads: [{ source, id: thread }],
    actor: { source, id: args.actor },
    human: true,
    addressed: 'direct',
    at: new Date().toISOString(),
    text: args.text,
    channel: { source, thread, address },
    meta: { ...args.chatId ? { chatId: args.chatId, chatType: 'p2p' } : {}, ...args.messageId ? { messageId: args.messageId } : {}, dispatched: true },
  }
}

function refusal(error: unknown): { isError: true; output: [{ type: 'text'; text: string }] } {
  const text = error instanceof UserError ? error.message : String((error as Error)?.message ?? error)
  return { isError: true, output: [{ type: 'text', text }] }
}
