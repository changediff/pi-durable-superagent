/** Port-level checks: Feishu message mapping and the allowAll gate. */
import { describe, expect, it } from 'vitest'
import { messageText, feishuThreadId } from '../src/pi/feishu.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import type { Thread, Trigger } from '../src/core/index.ts'

describe('feishu mapping', () => {
  it('reads text and rich-text messages', () => {
    expect(messageText({ message_id: 'm', chat_id: 'c', message_type: 'text', content: JSON.stringify({ text: '你好' }) })).toBe('你好')
    const post = JSON.stringify({ zh_cn: { content: [[{ tag: 'text', text: '第一行' }], [{ tag: 'text', text: '第二行' }]] } })
    expect(messageText({ message_id: 'm', chat_id: 'c', message_type: 'post', content: post })).toBe('第一行\n第二行')
    expect(messageText({ message_id: 'm', chat_id: 'c', message_type: 'image', content: '{}' })).toBe('[图片消息]')
  })

  it('keys a thread by chat and topic root', () => {
    // Conversation-level: p2p and plain group chats have no root_id, so every message shares one chat-level Thread.
    expect(feishuThreadId('oc_1', undefined, 'om_1')).toBe('oc_1:chat')
    expect(feishuThreadId('oc_1', undefined, 'om_2')).toBe('oc_1:chat')
    expect(feishuThreadId('oc_1', 'om_root', 'om_2')).toBe('oc_1:om_root')
    expect(feishuThreadId('oc_2', 'om_root', 'om_3')).toBe('oc_2:om_root')
    // Topic threads stay distinct per root, and later messages in the same topic share the root's key.
    expect(feishuThreadId('oc_1', 'om_root_b', 'om_4')).not.toBe(feishuThreadId('oc_1', 'om_root', 'om_2'))
  })
})

describe('allowAll admission', () => {
  const settings = SettingsSchema.parse({ policy: { sources: { feishu: { allowAll: true } } }, eval: { mode: 'auto' } })
  const scope = { scope: () => ({ listened: true as const, observed: false, row: 'direct' }) }
  const policy = settingsPolicy(settings, scope)
  const thread: Thread = { key: 'feishu:oc_1', ref: { source: 'feishu', id: 'oc_1' }, createdAt: '2026-01-01T00:00:00.000Z', subscriptions: [], correlated: [], pending: [], meta: {} }
  const trigger: Trigger = {
    id: 'fs-1', source: 'feishu', threads: [{ source: 'feishu', id: 'oc_1' }], actor: { source: 'feishu', id: 'ou_any' },
    human: true, addressed: 'direct', at: '2026-01-01T00:00:00.000Z', text: 'hi', meta: { chatType: 'p2p' },
  }

  it('admits an unlisted sender as explicit when the source allows everyone', () => {
    expect(policy.gate(trigger, thread, [])).toMatchObject({ admissible: true, strength: 'explicit' })
  })

  it('refuses the same sender when allowAll is off and no list entry exists', () => {
    const strict = settingsPolicy(SettingsSchema.parse({ policy: { sources: { feishu: { allowAll: false } } } }), scope)
    expect(strict.gate(trigger, thread, []).admissible).toBe(false)
  })
})
