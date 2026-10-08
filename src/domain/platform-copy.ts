import { en, zhCN } from './platform-messages.js'
import { zhErrorMessages } from './platform-error-messages.js'
import type { PlatformLocale } from './platform-language.js'
import type { CommunityErrorParams } from './admin-contract.js'
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
 const template = locale === 'zh-CN' && error.code && Object.hasOwn(zhErrorMessages, error.code) ? zhErrorMessages[error.code as keyof typeof zhErrorMessages] : error.error
 return interpolateMessage(template, error.params)
}
