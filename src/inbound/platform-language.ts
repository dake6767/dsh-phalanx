import type { IncomingMessage } from 'node:http'
import { languagePreference, resolvePlatformLocale } from '../domain/platform-language.js'
export function requestLanguage(request: IncomingMessage) {
 return { locale: resolvePlatformLocale(request.headers.cookie, request.headers['accept-language']), preference: languagePreference(request.headers.cookie) }
}
