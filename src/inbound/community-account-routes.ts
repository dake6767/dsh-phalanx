import { communitySpacePath } from '../domain/community-space.js'
import type { CommunityAccountRecord } from '../domain/community-account.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityEntry } from '../use-cases/community-entry.js'
import type { CommunityOnboarding } from '../use-cases/community-onboarding.js'
import { assertCommunityOrigin, readCommunityForm } from './community-request.js'
import { COMMUNITY_BOOTSTRAP_PAGE, COMMUNITY_LOGIN_PAGE } from './community-account-pages.js'
import { sendHtml, sendText } from './http-response.js'
import { issuedPlatformCookie, loginStorageHeaders, mountedDshCookie, secureDshCookie, type PlatformSessionCodec } from './platform-session.js'

export function communityAccountRoutes(deps: {
  readonly onboarding: CommunityOnboarding
  readonly entry: CommunityEntry
  readonly sessions: PlatformSessionCodec
  readonly origin: () => URL
}) {
  const signedIn = (request: IncomingMessage, response: ServerResponse, origin: URL, account: CommunityAccountRecord, cookies: readonly string[], recovery = false): void => {
    response.writeHead(303, { location: recovery ? '/recovery' : account.admin ? '/admin' : communitySpacePath(account.spaceId), 'cache-control': 'no-store',
      ...loginStorageHeaders(request, deps.sessions, account.spaceId, origin,
        [issuedPlatformCookie(deps.sessions, account, origin),
          ...cookies.map(cookie => secureDshCookie(mountedDshCookie(cookie, communitySpacePath(account.spaceId)), origin))]) })
    response.end()
  }
  return {
    enter: async (request: IncomingMessage, response: ServerResponse, username: string, origin: URL): Promise<void> => {
      const account = deps.entry.account(username)
      const cookies = await deps.entry.openSpace(account, origin)
      response.writeHead(303, { location: communitySpacePath(account.spaceId), 'cache-control': 'no-store',
        'set-cookie': cookies.map(cookie => secureDshCookie(mountedDshCookie(cookie, communitySpacePath(account.spaceId)), origin)) })
      response.end()
    },
    loginForm: (response: ServerResponse): void => { sendHtml(response, 200, COMMUNITY_LOGIN_PAGE) },
    bootstrap: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      if (deps.onboarding.bootstrapComplete()) { sendText(response, 404, 'Not Found'); return }
      if (request.method === 'GET') { sendHtml(response, 200, COMMUNITY_BOOTSTRAP_PAGE); return }
      if (request.method !== 'POST') { sendText(response, 405, 'Method Not Allowed'); return }
      assertCommunityOrigin(request, deps.origin())
      const form = await readCommunityForm(request)
      const account = await deps.onboarding.bootstrap(form.get('credential') ?? '', {
        username: form.get('username') ?? '', email: form.get('email') ?? '', password: form.get('password') ?? '',
      })
      signedIn(request, response, deps.origin(), account, [])
    },
    login: async (request: IncomingMessage, response: ServerResponse, origin: URL): Promise<void> => {
      assertCommunityOrigin(request, origin)
      const form = await readCommunityForm(request)
      const { account, cookies, recovery } = await deps.entry.signIn(form.get('username') ?? '', form.get('password') ?? '', origin)
      signedIn(request, response, origin, account, cookies, recovery)
    },
  }
}
