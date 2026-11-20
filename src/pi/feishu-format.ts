/**
 * Feishu rich-text rendering, ported from openclaw's `extensions/feishu/src/markdown.ts` and the
 * `buildStructuredCard` half of its `send.ts`. Pure functions only — no lark client, no I/O.
 *
 * Feishu offers two rich paths and openclaw picks by content: rich post (`msg_type: "post"` with one
 * `md` element — native bold/headings/lists/links, but no tables and no single newlines) and the
 * schema-2.0 interactive card (`markdown` element — tables and code blocks render). Plain `text`
 * remains as the rollback path, byte-for-byte what the port sent before this module existed.
 */
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table'
import { gfmTable } from 'micromark-extension-gfm-table'

/** Serialized envelope ceiling shared by rich post (API hard limit) and cards (same budget). */
export const FEISHU_ENVELOPE_MAX_BYTES = 30 * 1024

/** Feishu header color templates (`card.header.template` whitelist). */
const CARD_TEMPLATES = ['blue', 'wathet', 'turquoise', 'green', 'yellow', 'orange', 'red', 'carmine', 'violet', 'purple', 'indigo', 'grey']

export type FeishuRenderMode = 'auto' | 'post' | 'card' | 'text'

/** Structural slice of mdast: enough to walk node positions, nothing more. */
type MarkdownNode = {
  type: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MarkdownNode[]
}

/** Tables and fenced code render only in cards; everything else fits the post `md` element. */
export function shouldUseFeishuCard(text: string): boolean {
  return /```[\s\S]*?```/.test(text) || /\|.+\|[\r\n]+\|[-:| ]+\|/.test(text)
}

function parseMarkdown(text: string): MarkdownNode {
  const root: MarkdownNode = fromMarkdown(text, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  })
  return root
}

function visitMarkdown(root: MarkdownNode, visitor: (node: MarkdownNode) => void): void {
  const pending = [root]
  while (pending.length > 0) {
    const node = pending.pop()
    if (!node) continue
    visitor(node)
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index -= 1) {
      const child = node.children?.[index]
      if (child) pending.push(child)
    }
  }
}

/** Line endings that live inside a `text` node: CommonMark soft breaks, and nothing else. */
function collectSoftBreakOffsets(text: string): number[] {
  const root = parseMarkdown(text)
  const offsets: number[] = []
  visitMarkdown(root, (node) => {
    if (node.type !== 'text') return
    const start = node.position?.start.offset
    const end = node.position?.end.offset
    if (start === undefined || end === undefined) return
    for (let offset = start; offset < end; offset += 1) {
      const char = text[offset]
      if (char === '\n') {
        // A `\n` after `\r` belongs to the `\r\n` pair handled below.
        if (text[offset - 1] !== '\r') offsets.push(offset)
        continue
      }
      if (char === '\r') {
        offsets.push(offset)
        if (text[offset + 1] === '\n') offset += 1
      }
    }
  })
  return offsets.toSorted((left, right) => left - right)
}

/**
 * Materialize CommonMark soft breaks for the post `md` element, which drops single newlines unless
 * the break is a hard one. The parser finds only soft breaks (newlines inside paragraph text
 * nodes); code blocks, tables, headings and existing hard breaks keep their source bytes.
 */
export function materializeSoftBreaks(text: string): string {
  if (!text.includes('\n') && !text.includes('\r')) return text
  const softBreakOffsets = collectSoftBreakOffsets(text)
  if (softBreakOffsets.length === 0) return text
  const parts: string[] = []
  let cursor = 0
  for (const offset of softBreakOffsets) {
    const lineEnding = text[offset] === '\r' ? (text[offset + 1] === '\n' ? '\r\n' : '\r') : '\n'
    parts.push(text.slice(cursor, offset), '  ', lineEnding)
    cursor = offset + lineEnding.length
  }
  parts.push(text.slice(cursor))
  return parts.join('')
}

/** Rich post envelope: one `md` element; Feishu renders its markdown natively. */
export function buildPostContent(markdown: string): string {
  return JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text: markdown }]] } })
}

/** Card header color: known templates pass through, anything else falls back to blue. */
function cardTemplate(template: string | undefined): string {
  return template && CARD_TEMPLATES.includes(template) ? template : 'blue'
}

/** Schema-2.0 interactive card with a single `markdown` element. The markdown is NOT escaped. */
export function buildCard(markdown: string, header?: { title: string; template?: string }): Record<string, unknown> {
  const card: Record<string, unknown> = {
    schema: '2.0',
    config: { width_mode: 'fill' },
    body: { elements: [{ tag: 'markdown', content: markdown }] },
  }
  if (header) {
    card.header = { title: { tag: 'plain_text', content: header.title }, template: cardTemplate(header.template) }
  }
  return card
}

export type RenderedFeishuMessage = { msgType: 'post' | 'interactive' | 'text'; content: string }

/**
 * One markdown text to a Feishu wire payload. `text` reproduces the pre-port plain envelope;
 * `post` and `card` force their path; `auto` decides on the original text (so card content is
 * never touched by soft-break materialization — only the post path materializes).
 */
export function renderFeishuMessage(text: string, mode: FeishuRenderMode): RenderedFeishuMessage {
  if (mode === 'text') return { msgType: 'text', content: JSON.stringify({ text }) }
  if (mode === 'card' || (mode === 'auto' && shouldUseFeishuCard(text))) {
    return { msgType: 'interactive', content: JSON.stringify(buildCard(text)) }
  }
  return { msgType: 'post', content: buildPostContent(materializeSoftBreaks(text)) }
}

// ---------------------------------------------------------------------------
// Chunking: every chunk must be independently valid markdown (fences balanced) and its rendered
// envelope must fit the transport byte limit. Char-level splitting is the last resort.
// ---------------------------------------------------------------------------

/** An open fenced code block: the original opening line (kept for reopening with its info string) and marker. */
type OpenFence = { openLine: string; char: string; len: number }

/** The fence marker of a line (``` or ~~~), if the line starts with one. */
function fenceMarker(line: string): string | null {
  return /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? null
}

/** Fence state machine over lines: a marker line opens a fence when outside, closes it when the marker matches and nothing else is on the line. */
function advanceFence(state: OpenFence | null, line: string): OpenFence | null {
  const chars = fenceMarker(line)
  if (chars === null) return state
  const char = chars[0] ?? '`'
  const len = chars.length
  if (state) {
    const closing = state.char === char && len >= state.len && line.trim() === chars
    return closing ? null : state
  }
  return { openLine: line.trim(), char, len }
}

/** Split into lines, each keeping its trailing `\n` (the last keeps whatever it had), so joins reproduce the source exactly. */
function splitKeepNewlines(text: string): string[] {
  const raw = text.split('\n')
  return raw.map((line, index) => (index === raw.length - 1 ? line : `${line}\n`))
}

/** Character-split an unbreakable single line; code-point safe, and a pure partition of the line. */
function splitChars(line: string, limit: number): string[] {
  if (limit < 1 || line.length <= limit) return [line]
  const chars = Array.from(line)
  const pieces: string[] = []
  for (let index = 0; index < chars.length; index += limit) pieces.push(chars.slice(index, index + limit).join(''))
  return pieces
}

/**
 * Fence-aware markdown chunker (openclaw `chunkMarkdownTextWithMode` semantics, "length" mode):
 * break at blank lines when possible, at line ends when not, never inside a fenced code block,
 * and hard-split a lone over-long line. Chunks join back to exactly the input.
 */
function chunkMarkdown(text: string, limit: number): string[] {
  if (limit < 1) return [text]
  if (text.length <= limit) return [text]
  const lines = splitKeepNewlines(text)
  const chunks: string[] = []
  let start = 0
  let index = 0
  let state: OpenFence | null = null
  /** Break candidates as line indexes: chunk boundaries may sit before these lines. */
  let afterBlank: number | null = null
  let atSafe: number | null = null
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const stateBefore = state
    const wasBlank = stateBefore === null && line.trim() === ''
    state = advanceFence(state, line)
    index += 1
    const safe = state === null // a boundary before `index` keeps every fence closed
    if (safe && index < lines.length) {
      if (wasBlank) { afterBlank = index; atSafe = index } else atSafe = index
    }
    const used = lines.slice(start, index).join('').length
    if (used <= limit) continue
    const at = afterBlank !== null && afterBlank > start ? afterBlank : atSafe !== null && atSafe > start ? atSafe : null
    if (at !== null) {
      chunks.push(lines.slice(start, at).join(''))
      start = at
      continue
    }
    // A lone line over the limit can only be character-split when it is plain content, never a
    // fence marker or fenced code — those keep their bytes and defer to the envelope-stage repair.
    if (index === start + 1 && state === null && stateBefore === null && fenceMarker(line) === null) {
      chunks.push(...splitChars(line, limit))
      start = index
    }
    // Inside a fence with no safe boundary yet: keep accumulating; the envelope stage will bite if it must.
  }
  if (start < lines.length) chunks.push(lines.slice(start).join(''))
  return chunks.filter(chunk => chunk.length > 0)
}

/** Repair a slice cut inside a fence: close it at the end, reopen at the next slice's start. */
function withFenceRepair(body: string, open: OpenFence | null): { piece: string; stateAfter: OpenFence | null } {
  let state = open
  for (const line of body.split('\n')) state = advanceFence(state, line)
  const prefix = open ? `${open.openLine}\n` : ''
  const suffix = state ? `\n${state.char.repeat(Math.max(3, state.len))}` : ''
  return { piece: `${prefix}${body}${suffix}`, stateAfter: state }
}

/**
 * Last resort for a chunk whose envelope cannot fit at any character limit (one giant fenced
 * block): binary-search the largest prefix that fits, cutting fences mid-block and repairing them.
 */
function chunkByBytes(text: string, byteLimit: number, render: (chunk: string) => string): string[] {
  const chars = Array.from(text)
  const chunks: string[] = []
  let start = 0
  let open: OpenFence | null = null
  while (start < chars.length) {
    let low = start + 1
    let high = chars.length
    let best = start + 1
    while (low <= high) {
      const mid = Math.floor((low + high) / 2)
      const { piece } = withFenceRepair(chars.slice(start, mid).join(''), open)
      if (Buffer.byteLength(render(piece), 'utf8') <= byteLimit) { best = mid; low = mid + 1 } else high = mid - 1
    }
    const { piece, stateAfter } = withFenceRepair(chars.slice(start, best).join(''), open)
    chunks.push(piece)
    open = stateAfter
    start = best
  }
  return chunks
}

/**
 * Chunk markdown for Feishu under two budgets: `charLimit` keeps messages readable, `byteLimit`
 * is the serialized envelope the API enforces (30 KB). `render` produces exactly the envelope that
 * will be sent, so wrappers, JSON escapes and UTF-8 all count. Oversized chunks re-split at lower
 * character limits, then fall back to byte-level cuts with fence repair.
 */
export function chunkFeishuText(
  text: string,
  opts: { charLimit: number; byteLimit: number },
  render: (chunk: string) => string,
): string[] {
  if (!text) return []
  const byteLimit = opts.byteLimit > 0 ? opts.byteLimit : Number.MAX_SAFE_INTEGER
  const requested = Number.isFinite(opts.charLimit) && opts.charLimit > 0 ? Math.floor(opts.charLimit) : text.length
  const envelopeBytes = (chunk: string): number => Buffer.byteLength(render(chunk), 'utf8')
  const output: string[] = []
  for (const initial of chunkMarkdown(text, requested)) {
    if (envelopeBytes(initial) <= byteLimit) {
      output.push(initial)
      continue
    }
    let limit = Math.max(1, Math.min(requested, initial.length))
    for (;;) {
      const pieces = chunkMarkdown(initial, limit)
      let largest = 0
      let oversized: string | undefined
      for (const piece of pieces) {
        const bytes = envelopeBytes(piece)
        largest = Math.max(largest, bytes)
        if (bytes > byteLimit && oversized === undefined) oversized = piece
      }
      if (oversized === undefined) {
        output.push(...pieces)
        break
      }
      if (limit <= 1) {
        output.push(...chunkByBytes(initial, byteLimit, render))
        break
      }
      // Scale by the observed serialized size, then force progress for envelope overhead and fence wrappers.
      limit = Math.max(1, Math.min(limit - 1, Math.floor((limit * byteLimit) / Math.max(largest, 1)) - 1))
    }
  }
  return output
}
