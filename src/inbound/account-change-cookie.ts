import { serializeCookie } from 'cookie-es'
import { ACCOUNT_EVENT_COOKIE } from '../domain/platform-account-sync.js'
/** A short-lived browser handoff, never a credential or account identifier. */
export function accountChangeCookie(type: 'switched' | 'logged-out' | 'signed-out-all', origin: URL): string {
  return serializeCookie(ACCOUNT_EVENT_COOKIE, type, { path: '/', sameSite: 'strict', secure: origin.protocol === 'https:', maxAge: 60 })
}
