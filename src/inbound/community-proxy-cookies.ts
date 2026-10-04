import type { IncomingMessage } from 'node:http'
import { secureDshCookie } from './platform-session.js'

/** Backend cookies retain the browser origin's policy when TLS ends at an external proxy. */
export function secureCommunityProxyCookies(origin: () => URL) {
  return (upstream: IncomingMessage): void => {
    const cookies = upstream.headers['set-cookie']
    if (cookies !== undefined) upstream.headers['set-cookie'] = cookies.map(cookie => secureDshCookie(cookie, origin()))
  }
}
