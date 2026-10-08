/** Browser-local platform language; independent of account identity and DSH preferences. */
export type PlatformLocale = 'en' | 'zh-CN'
export type PlatformLanguagePreference = 'system' | PlatformLocale
export const PLATFORM_LANGUAGE_COOKIE = 'dsh-phalanx.lang'
export function languagePreference(cookie = ''): PlatformLanguagePreference {
 const value = cookie.split(';').map(part => part.trim()).find(part => part.startsWith(`${PLATFORM_LANGUAGE_COOKIE}=`))?.slice(PLATFORM_LANGUAGE_COOKIE.length + 1)
 return value === 'en' || value === 'zh-CN' ? value : 'system'
}
export function resolvePlatformLocale(cookie?: string, acceptLanguage = 'en'): PlatformLocale {
 const preference = languagePreference(cookie)
 if (preference !== 'system') return preference
 const languages = acceptLanguage.split(',').map(part => {
  const [tag = '', weight] = part.trim().split(';')
  const quality = weight === undefined ? 1 : Number(weight.trim().replace(/^q=/u, ''))
  return { tag: tag.toLowerCase(), quality }
 }).filter(item => Number.isFinite(item.quality) && item.quality > 0 && item.quality <= 1).sort((a, b) => b.quality - a.quality)
 const preferred = languages[0]?.tag ?? 'en'
 return preferred === 'zh' || preferred.startsWith('zh-') ? 'zh-CN' : 'en'
}
export function platformLanguageCookie(preference: PlatformLanguagePreference): string {
 return `${PLATFORM_LANGUAGE_COOKIE}=${preference}; Path=/; Max-Age=31536000; SameSite=Lax`
}
