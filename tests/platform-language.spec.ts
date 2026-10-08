import { expect, it } from 'vitest'
import { languagePreference, resolvePlatformLocale, platformLanguageCookie } from '../src/domain/platform-language.js'
it('resolves explicit cookie preferences before browser languages and treats invalid values as system', () => {
 expect(resolvePlatformLocale('dsh-phalanx.lang=en', 'zh-TW, en;q=0.8')).toBe('en')
 expect(resolvePlatformLocale('dsh-phalanx.lang=zh-CN', 'fr-FR')).toBe('zh-CN')
 for (const cookie of [undefined, 'dsh-phalanx.lang=system', 'dsh-phalanx.lang=garbage', 'dsh-phalanx.lang=%broken']) {
  expect(resolvePlatformLocale(cookie, 'zh-HK, en;q=0.8')).toBe('zh-CN')
  expect(resolvePlatformLocale(cookie, 'fr-FR, zh-CN;q=0.5')).toBe('en')
 }
 expect(resolvePlatformLocale(undefined, 'en;q=0.5, zh-SG;q=0.9')).toBe('zh-CN')
 expect(resolvePlatformLocale(undefined, 'zh-CN;q=0,en;q=1')).toBe('en')
 expect(resolvePlatformLocale(undefined, 'zh')).toBe('zh-CN')
 expect(resolvePlatformLocale()).toBe('en')
 expect(languagePreference('other=a; dsh-phalanx.lang=zh-CN')).toBe('zh-CN')
 expect(platformLanguageCookie('zh-CN')).toBe('dsh-phalanx.lang=zh-CN; Path=/; Max-Age=31536000; SameSite=Lax')
})
