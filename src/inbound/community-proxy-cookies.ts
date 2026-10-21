import type { IncomingMessage, ServerResponse } from 'node:http'
import { secureDshCookie } from './platform-session.js'

/** Backend cookies retain the browser origin's policy when TLS ends at an external proxy. */
export function secureCommunityProxyCookies(origin: () => URL) {
  return (upstream: IncomingMessage, _request: IncomingMessage, response: ServerResponse): void => {
    const existing = response.getHeader('set-cookie')
    const cookies = [...(Array.isArray(existing) ? existing : typeof existing === 'string' ? [existing] : []), ...(upstream.headers['set-cookie'] ?? [])]
    if (cookies.length) upstream.headers['set-cookie'] = cookies.map(cookie => secureDshCookie(cookie, origin()))
  }
}
