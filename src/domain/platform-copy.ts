import { en as pluginEn, zhCN as pluginZh } from './plugin-messages.js'
import { en as groupEn, zhCN as groupZh } from './group-messages.js'
import { en as updateEn, zhCN as updateZh } from './model-update-messages.js'
import { en as accountEn, zhCN as accountZh } from './account-messages.js'
import { en as platformEn, zhCN as platformZh } from './platform-messages.js'
import { enErrorMessages, zhErrorMessages } from './platform-error-messages.js'
import type { PlatformLocale } from './platform-language.js'
import type { CommunityErrorParams } from './admin-contract.js'
const en = { ...platformEn, ...accountEn, ...updateEn, ...groupEn, ...pluginEn }
const zhCN = { ...platformZh, ...accountZh, ...updateZh, ...groupZh, ...pluginZh }
export const platformMessages = { en, 'zh-CN': zhCN }
export const platformErrorMessages = { en: enErrorMessages, 'zh-CN': zhErrorMessages }
export type PlatformMessageKey = keyof typeof en
export interface PlatformMessage { readonly key: PlatformMessageKey; readonly params?: CommunityErrorParams }
export function interpolateMessage(message: string, params: CommunityErrorParams = {}): string {
 return message.replace(/\{([a-zA-Z]+)\}/gu, (placeholder, key: string) => params[key] === undefined ? placeholder : String(params[key]))
}
export function platformText(locale: PlatformLocale, key: PlatformMessageKey, params?: CommunityErrorParams): string {
 return interpolateMessage((locale === 'zh-CN' ? zhCN : en)[key], params)
}
/** Unknown/new server codes retain the English diagnostic for older clients. */
export function platformError(locale: PlatformLocale, error: { readonly code?: string | undefined; readonly error: string; readonly params?: CommunityErrorParams | undefined }): string {
 const template = locale === 'zh-CN' && error.code && Object.hasOwn(zhErrorMessages, error.code) ? zhErrorMessages[error.code as keyof typeof zhErrorMessages] : error.error || (error.code && Object.hasOwn(enErrorMessages, error.code) ? enErrorMessages[error.code as keyof typeof enErrorMessages] : platformText(locale, 'Request failed'))
 const phases: Record<string, string> = { stop: '停止实例', backup: '备份', reset: '重置', start: '启动实例' }
 const params = locale === 'zh-CN' && error.code === 'environment-recovery-failed' && typeof error.params?.phase === 'string'
  ? { ...error.params, phase: phases[error.params.phase] ?? error.params.phase } : error.params
 return interpolateMessage(template, params)
}
