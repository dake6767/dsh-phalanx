import { expect, it } from 'vitest'
import { platformError, platformText, platformMessages, platformErrorMessages } from '../src/domain/platform-copy.js'
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

it('keeps both complete dictionaries and every interpolation parameter in sync', () => {
 const placeholders = (value: string) => [...value.matchAll(/\{([a-zA-Z]+)\}/gu)].map(match => match[1]).sort()
 for (const dictionary of [platformMessages, platformErrorMessages]) {
  expect(Object.keys(dictionary['zh-CN']).sort()).toEqual(Object.keys(dictionary.en).sort())
  for (const [key, value] of Object.entries(dictionary.en)) {
   const translated = (dictionary['zh-CN'] as Record<string, string>)[key]!
   expect(value.length, key).toBeGreaterThan(0)
   expect(translated.length, key).toBeGreaterThan(0)
   expect(placeholders(translated), key).toEqual(placeholders(value))
  }
 }
 expect(platformError('zh-CN', { code: 'runtime-upgrade-unavailable', error: 'Diagnostic' })).toContain('升级准备失败')
 expect(platformError('zh-CN', { code: 'environment-recovery-failed', error: 'Failed', params: { phase: 'backup' } })).toContain('阶段：备份')
})
