import { expect, it } from 'vitest'
import { platformError, platformText } from '../src/domain/platform-copy.js'
import { communityLoginPage } from '../src/inbound/community-account-pages.js'
it('localizes known codes, preserves server English for unknown codes and renders template parameters literally', () => {
 expect(platformError('zh-CN', { code: 'email-in-use', error: 'Email is already in use' })).toBe('此邮箱已被使用。')
 expect(platformError('en', { code: 'email-in-use', error: 'Email is already in use' })).toBe('Email is already in use')
 expect(platformError('zh-CN', { code: 'future-code', error: 'New server diagnostic' })).toBe('New server diagnostic')
 expect(platformError('zh-CN', { code: 'constructor', error: 'Unknown' })).toBe('Unknown')
 expect(platformText('zh-CN', 'Restart failed. {error} You can retry or ask an administrator to reset your DSH environment.', { error: '$& <raw>' })).toContain('$& <raw>')
})
it('emits localized first paint and escapes user-visible error text independently of admin assets', () => {
 const html = communityLoginPage('<img onerror=attack()>', 'zh-CN', 'zh-CN')
 expect(html).toContain('<html lang="zh-CN">')
 expect(html).toContain('<h1>登录 dsh-phalanx</h1>')
 expect(html).toContain('value="zh-CN" selected')
 expect(html).toContain('&lt;img onerror=attack()&gt;')
 expect(html).not.toContain('/admin/assets/')
})
