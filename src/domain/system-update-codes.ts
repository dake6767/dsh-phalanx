import codes from './system-update-codes.json' with { type: 'json' }

/** Stable update labels shared with the independently running executor. */
export const systemUpdateCodes = codes
export type SystemUpdateErrorCode = keyof typeof codes.errors
export function systemUpdateText(code: string, locale: 'en' | 'zh-CN'): string | undefined {
  for (const group of [codes.phases, codes.outcomes, codes.errors]) {
    if (Object.hasOwn(group, code)) return (group as Readonly<Record<string, { en: string; 'zh-CN': string }>>)[code]![locale]
  }
  return undefined
}
