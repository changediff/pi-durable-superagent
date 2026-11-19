/**
 * Router assessment (the port's replacement for `src/app/assessment.ts`).
 *
 * The DSH build asked the main Session's model to call `orchestrator_eval_decide` tools. The port makes the
 * same judgement with one plain GLM call: given the thread window and the person's message, decide whether
 * this is work for a worker (`accept`) or ordinary chatter (`ignore`), and return a title, a scope line and
 * an acknowledgement. The domain still owns authority: `Engine.decide` re-checks the gate, admission and
 * mandate before a Ticket exists.
 */
import type { Candidate, Outcome } from '../core/index.ts'
import type { Config } from './config.ts'

const SYSTEM = `你是超级智能体（super-agent）的 Router（路由器），负责把飞书里人类的消息分派给 Worker 执行。
你只做判断，不执行任务。对每条候选消息输出一个 JSON 对象，不要输出任何其他文字。

判定规则：
- accept：发信人明确要求你做事（回答问题、查资料、跑命令、写/改代码、排查故障、整理文档、设定提醒等）。
- accept（寒暄也要回）：人类发来的问候、打招呼、试探性消息（"你好""在吗""测试""你是谁"）同样 accept，title 用"回应问候"，scope 写"用一两句话友好回应对方，并简短说明你能做什么；不要创建文件、不要执行命令、不要询问具体任务以外的问题"。用户看不到"忽略"，静默不回等同于机器人坏了。
- ignore：仅用于机器人自己的回显、系统消息、纯表情、以及完全无法理解的碎片。
- 若消息是追问或补充上文，且上文已经有任务，也 accept，title 用同一任务的名称。
- 不要因为任务"看起来简单"就 ignore；Worker 会自己决定怎么做。
- title：不超过 40 字的中文短标题，说明这件事是什么（不要用"用户请求"这种空话）。
- scope：一句话说明 Worker 要交付什么，包含必要的对象、路径、验收标准。
- acknowledgement：一句 10-20 字的中文回执，例如"收到，我去查一下"。

输出 JSON 结构：
{"decision":"accept"|"ignore","title":"...","scope":"...","reason":"...","acknowledgement":"..."}
ignore 时 title/scope/acknowledgement 可以省略。`

export interface AssessorHost {
  decide(triggerId: string, outcome: Outcome): void
  log(message: string, detail?: unknown): void
}

type Reply = { decision?: string; title?: string; scope?: string; reason?: string; acknowledgement?: string }

export class GlmAssessor {
  private readonly inFlight = new Map<string, AbortController>()

  constructor(private readonly cfg: Pick<Config, 'model' | 'baseUrl' | 'apiKeyEnv'>, private readonly host: AssessorHost) {}

  request(candidate: Candidate): void {
    const trigger = candidate.triggers.at(-1)
    if (!trigger) return
    const controller = new AbortController()
    this.inFlight.set(candidate.evalId, controller)
    void this.run(candidate, controller.signal).then(
      reply => {
        const outcome = this.toOutcome(candidate, reply)
        this.host.decide(trigger.id, { ...outcome, evalId: candidate.evalId })
      },
      error => {
        this.host.log('assessment failed', String((error as Error)?.message ?? error))
        this.host.decide(trigger.id, { kind: 'unavailable', reason: 'assess_failed', evalId: candidate.evalId })
      },
    ).finally(() => this.inFlight.delete(candidate.evalId))
  }

  release(evalId: string): void {
    this.inFlight.get(evalId)?.abort()
    this.inFlight.delete(evalId)
  }

  private toOutcome(candidate: Candidate, reply: Reply): Outcome {
    const reason = reply.reason?.slice(0, 300) || 'Router 判定'
    if (reply.decision !== 'accept') return { kind: 'ignore', reason }
    if (candidate.strength === 'inferred') {
      // Inferred candidates need enabled rules and auto mode; the chat port keeps them observable only.
      return { kind: 'ignore', reason: 'inferred_shadow', audit: { would_accept: true, title: reply.title, scope: reply.scope } }
    }
    return {
      kind: 'accept',
      title: (reply.title || '飞书任务').slice(0, 80),
      scope: (reply.scope || triggerText(candidate)).slice(0, 500),
      reason,
      ...(reply.acknowledgement ? { acknowledgement: reply.acknowledgement.slice(0, 120) } : {}),
      audit: { model: this.cfg.model, router: 'glm' },
    }
  }

  private async run(candidate: Candidate, signal: AbortSignal): Promise<Reply> {
    const messages = candidate.triggers.slice(-5).map(trigger => ({
      role: 'user' as const,
      content: `[${trigger.at}] ${trigger.human ? '人类' : '机器人'}: ${trigger.text}`,
    }))
    const ticketNote = candidate.tickets.length
      ? `\n本线程已有工单：${candidate.tickets.map(ticket => `${ticket.id}「${ticket.title}」`).join('、')}`
      : ''
    const body = {
      model: this.cfg.model,
      messages: [
        { role: 'system', content: SYSTEM },
        ...messages,
        { role: 'user', content: `候选强度：${candidate.strength}${ticketNote}\n请输出 JSON。` },
      ],
      temperature: 0.2,
      max_tokens: 800,
    }
    const key = process.env[this.cfg.apiKeyEnv] ?? ''
    const response = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal,
    })
    if (!response.ok) throw new Error(`GLM ${response.status}: ${(await response.text()).slice(0, 300)}`)
    const payload = await response.json() as { choices?: { message?: { content?: string } }[] }
    const text = payload.choices?.[0]?.message?.content ?? ''
    return parseReply(text)
  }
}

function parseReply(text: string): Reply {
  const cleaned = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end <= start) return { decision: 'ignore', reason: 'unparseable_assessment' }
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Reply
  } catch {
    return { decision: 'ignore', reason: 'unparseable_assessment' }
  }
}

const triggerText = (candidate: Candidate): string => candidate.triggers.at(-1)?.text.slice(0, 200) ?? ''
