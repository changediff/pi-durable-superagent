/** Feishu rich-text rendering ported from openclaw: post/card routing, soft-break materialization,
 * fence-aware chunking under the serialized envelope limit, and the plain-text rollback path. */
import { describe, expect, it } from 'vitest'
import {
  FEISHU_ENVELOPE_MAX_BYTES,
  buildCard,
  chunkFeishuText,
  materializeSoftBreaks,
  renderFeishuMessage,
  shouldUseFeishuCard,
} from '../src/pi/feishu-format.ts'

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8')
const fences = (text: string): number => (text.match(/```/g) ?? []).length
/** Post envelope → the inner md element. */
const postElement = (content: string): { tag: string; text: string } =>
  (JSON.parse(content) as { zh_cn: { content: { tag: string; text: string }[][] } }).zh_cn.content[0]![0]!
/** Card envelope → the markdown element. */
const cardElement = (content: string): { tag: string; content: string } =>
  ((JSON.parse(content) as { body: { elements: { tag: string; content: string }[] } }).body.elements)[0]!

const PROSE = '# 周报\n\n**本周**完成了 `feishu` 渠道的接入：\n\n- 富文本渲染\n- 分块发送'
const TABLE = '| 用例 | 结果 |\n|---|---|\n| 粗体 | pass |\n| 表格 | pass |'
const CODE = '下面是实现的入口：\n\n```ts\nconst render = (text: string) => renderFeishuMessage(text, "auto")\nconst send = async (chunk: string) => client.reply(chunk)\n```'

describe('shouldUseFeishuCard', () => {
  it('sends fenced code and GFM tables to the card, everything else to the post', () => {
    expect(shouldUseFeishuCard(CODE)).toBe(true)
    expect(shouldUseFeishuCard(TABLE)).toBe(true)
    expect(shouldUseFeishuCard(PROSE)).toBe(false)
  })
})

describe('renderFeishuMessage', () => {
  it('renders markdown prose as a rich post with one md element carrying the source text', () => {
    const { msgType, content } = renderFeishuMessage(PROSE, 'auto')
    expect(msgType).toBe('post')
    const element = postElement(content)
    expect(element.tag).toBe('md')
    expect(element.text).toBe(PROSE)
  })
  it('routes GFM tables to an interactive card with a markdown element', () => {
    const { msgType, content } = renderFeishuMessage(`先看结论：\n\n${TABLE}`, 'auto')
    expect(msgType).toBe('interactive')
    const element = cardElement(content)
    expect(element.tag).toBe('markdown')
    expect(element.content).toBe(`先看结论：\n\n${TABLE}`)
  })
  it('routes fenced code to an interactive card', () => {
    expect(renderFeishuMessage(CODE, 'auto').msgType).toBe('interactive')
  })
  it('materializes soft breaks on the post path and leaves card content untouched', () => {
    const post = renderFeishuMessage('第一行\n第二行', 'auto')
    expect(post.msgType).toBe('post')
    expect(postElement(post.content).text).toBe('第一行  \n第二行')
    // Cards keep the original bytes: the auto decision runs on the raw text, before normalization.
    const card = renderFeishuMessage('第一行\n第二行', 'card')
    expect(card.msgType).toBe('interactive')
    expect(cardElement(card.content).content).toBe('第一行\n第二行')
  })
  it('forces its path when pinned, and auto defers to content', () => {
    expect(renderFeishuMessage(PROSE, 'card').msgType).toBe('interactive')
    expect(renderFeishuMessage(TABLE, 'post').msgType).toBe('post')
    expect(postElement(renderFeishuMessage(TABLE, 'post').content).text).toBe(TABLE)
  })
  it('reproduces the old plain-text envelope in text mode', () => {
    const { msgType, content } = renderFeishuMessage(PROSE, 'text')
    expect(msgType).toBe('text')
    expect(content).toBe(JSON.stringify({ text: PROSE }))
  })
})

describe('materializeSoftBreaks', () => {
  it('upgrades soft breaks to hard breaks by inserting two trailing spaces', () => {
    expect(materializeSoftBreaks('第一行\n第二行')).toBe('第一行  \n第二行')
  })
  it('keeps newlines inside fenced code blocks', () => {
    const code = '```ts\nconst a = 1\nconst b = 2\n```'
    expect(materializeSoftBreaks(code)).toBe(code)
  })
  it('keeps table rows byte-identical', () => {
    expect(materializeSoftBreaks(TABLE)).toBe(TABLE)
  })
  it('keeps structural line endings and existing hard breaks', () => {
    expect(materializeSoftBreaks('# 标题\n\n第一段\n第二段')).toBe('# 标题\n\n第一段  \n第二段')
    expect(materializeSoftBreaks('硬换行  \n之后')).toBe('硬换行  \n之后')
    expect(materializeSoftBreaks('反斜杠\\\n之后')).toBe('反斜杠\\\n之后')
  })
})

describe('buildCard', () => {
  it('builds the schema-2.0 card and whitelists header templates', () => {
    expect(buildCard(PROSE)).toEqual({
      schema: '2.0',
      config: { width_mode: 'fill' },
      body: { elements: [{ tag: 'markdown', content: PROSE }] },
    })
    const header = (card: Record<string, unknown>): { template: string } =>
      (card.header as { template: string })
    expect(header(buildCard(PROSE, { title: '结果', template: 'green' })).template).toBe('green')
    expect(header(buildCard(PROSE, { title: '结果', template: 'neon-pink' })).template).toBe('blue')
    expect(header(buildCard(PROSE, { title: '结果' })).template).toBe('blue')
  })
  it('does not escape the markdown content', () => {
    const html = '**bold** <b>&amp;</b> `code`'
    expect(cardElement(JSON.stringify(buildCard(html))).content).toBe(html)
  })
})

describe('chunkFeishuText', () => {
  const postEnvelope = (chunk: string): string => renderFeishuMessage(chunk, 'post').content
  const cardEnvelope = (chunk: string): string => renderFeishuMessage(chunk, 'card').content

  it('chunks at block boundaries and loses no content', () => {
    const blocks = Array.from({ length: 12 }, (_, index) => `## 第${index}节\n\n这是第${index}节的内容，足够长以便切分。`)
    const text = [...blocks, CODE].join('\n\n')
    const chunks = chunkFeishuText(text, { charLimit: 120, byteLimit: FEISHU_ENVELOPE_MAX_BYTES }, postEnvelope)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(bytes(postEnvelope(chunk))).toBeLessThanOrEqual(FEISHU_ENVELOPE_MAX_BYTES)
      expect(fences(chunk) % 2).toBe(0)
    }
    expect(chunks.join('')).toBe(text)
  })

  it('never places a chunk boundary inside a fenced code block', () => {
    const fence = '```bash\n' + Array.from({ length: 30 }, (_, i) => `echo "step ${i} of the deployment sequence"`).join('\n') + '\n```'
    const text = `准备：\n\n${fence}\n\n收尾：\n\n- 检查日志\n- 汇报结果`
    const chunks = chunkFeishuText(text, { charLimit: 80, byteLimit: FEISHU_ENVELOPE_MAX_BYTES }, cardEnvelope)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(fences(chunk) % 2).toBe(0)
      // No chunk starts or ends in the middle of the fence's content.
      expect(chunk.trim().startsWith('echo')).toBe(false)
      expect(bytes(cardEnvelope(chunk))).toBeLessThanOrEqual(FEISHU_ENVELOPE_MAX_BYTES)
    }
    expect(chunks.join('')).toBe(text)
  })

  it('enforces the serialized envelope limit, repairing fences when it must byte-split', () => {
    const line = `const value${'x'.repeat(120)} = "这是一段很长的代码行，用来撑爆卡片的序列化信封";`
    const text = '```ts\n' + Array.from({ length: 24 }, (_, i) => `${line} // ${i}`).join('\n') + '\n```'
    const byteLimit = 800
    const chunks = chunkFeishuText(text, { charLimit: 7000, byteLimit }, cardEnvelope)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(bytes(cardEnvelope(chunk))).toBeLessThanOrEqual(byteLimit)
      expect(fences(chunk) % 2).toBe(0)
    }
    // Every original character survives the byte cuts; the only additions are repair fence-marker
    // lines, so dropping those lines and gluing the rest back must reproduce the source content.
    const contentOf = (source: string): string =>
      source.split('\n')
        .filter(sourceLine => sourceLine.trim() !== '' && !/^(`{3,}|~{3,})/.test(sourceLine.trim()))
        .join('')
    expect(contentOf(chunks.join(''))).toBe(contentOf(text))
  })

  it('keeps materialized post chunks within both limits and comparable in content', () => {
    const paragraphs = Array.from({ length: 20 }, (_, index) => `第${index}段：\n这里有两行内容，第二行经过软换行。`)
    const text = paragraphs.join('\n\n')
    const chunks = chunkFeishuText(text, { charLimit: 150, byteLimit: FEISHU_ENVELOPE_MAX_BYTES }, postEnvelope)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(160) // close to the requested readability limit
      expect(bytes(postEnvelope(chunk))).toBeLessThanOrEqual(FEISHU_ENVELOPE_MAX_BYTES)
    }
    // The only allowed difference is the two spaces materialized in front of soft breaks.
    expect(chunks.join('').replace(/  \n/g, '\n')).toBe(text)
  })

  it('returns no chunks for empty text', () => {
    expect(chunkFeishuText('', { charLimit: 100, byteLimit: 1024 }, postEnvelope)).toEqual([])
  })
})
