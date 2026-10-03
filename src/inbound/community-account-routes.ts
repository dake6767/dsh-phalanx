import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityEntry } from '../use-cases/community-entry.js'
import type { CommunityOnboarding } from '../use-cases/community-onboarding.js'
import { assertCommunityOrigin, readCommunityForm } from './community-request.js'
import { COMMUNITY_BOOTSTRAP_PAGE, COMMUNITY_LOGIN_PAGE } from './community-account-pages.js'
import { sendHtml, sendText } from './http-response.js'
import { issuedPlatformCookie, loginStorageHeaders, secureDshCookie, type PlatformSessionCodec } from './platform-session.js'

export function communityAccountRoutes(deps: {
  readonly onboarding: CommunityOnboarding
  readonly entry: CommunityEntry
  readonly sessions: PlatformSessionCodec
  readonly origin: () => URL
}) {
  return {
    loginForm: (response: ServerResponse): void => { sendHtml(response, 200, COMMUNITY_LOGIN_PAGE) },
    bootstrap: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      if (deps.onboarding.bootstrapComplete()) { sendText(response, 404, 'Not Found'); return }
      if (request.method === 'GET') { sendHtml(response, 200, COMMUNITY_BOOTSTRAP_PAGE); return }
      if (request.method !== 'POST') { sendText(response, 405, 'Method Not Allowed'); return }
      assertCommunityOrigin(request, deps.origin())
      const form = await readCommunityForm(request)
      await deps.onboarding.bootstrap(form.get('credential') ?? '', {
        username: form.get('username') ?? '', email: form.get('email') ?? '', password: form.get('password') ?? '',
      })
      response.writeHead(303, { location: '/login', 'cache-control': 'no-store' }); response.end()
    },
    login: async (request: IncomingMessage, response: ServerResponse, origin: URL): Promise<void> => {
      assertCommunityOrigin(request, origin)
      const form = await readCommunityForm(request)
      const { account, cookies } = await deps.entry.signIn(form.get('username') ?? '', form.get('password') ?? '', origin)
      response.writeHead(303, { location: account.admin ? '/admin' : '/', 'cache-control': 'no-store',
        ...loginStorageHeaders(request, deps.sessions, account.username, origin,
          [issuedPlatformCookie(deps.sessions, account.username, account.sessionEpoch, origin),
            ...cookies.map(cookie => secureDshCookie(cookie, origin))]) })
      response.end()
    },
  }
}
