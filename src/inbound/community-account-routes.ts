import { requestedPlatformDatabaseConnection } from '../domain/platform-database.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityDatabaseOnboarding } from '../use-cases/community-database-onboarding.js'
import { communityDatabaseForm } from './community-database-page.js'
import { sendCommunityJson } from './community-errors.js'
import { requestLanguage } from './platform-language.js'
import { communitySpacePath } from '../domain/community-space.js'
import type { CommunityAccountRecord } from '../domain/community-account.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityEntry } from '../use-cases/community-entry.js'
import type { CommunityOnboarding } from '../use-cases/community-onboarding.js'
import { assertCommunityOrigin, readCommunityForm } from './community-request.js'
import { communityAdministratorForm, communityBootstrapClosedPage, communityBootstrapPage, communityLoginPage } from './community-account-pages.js'
import { sendHtml, sendText } from './http-response.js'
import { issuedPlatformCookie, loginStorageHeaders, mountedDshCookie, secureDshCookie, type PlatformSessionCodec } from './platform-session.js'

export function communityAccountRoutes(deps: {
  readonly databaseOnboarding?: CommunityDatabaseOnboarding
  readonly recordsReady?: () => boolean
  readonly onboarding: CommunityOnboarding
  readonly entry: CommunityEntry
  readonly sessions: PlatformSessionCodec
  readonly origin: () => URL
}) {
  const signedIn = (request: IncomingMessage, response: ServerResponse, origin: URL, account: CommunityAccountRecord, cookies: readonly string[]): void => {
    response.writeHead(303, {
      location: account.admin ? '/admin' : communitySpacePath(account.spaceId),
      'cache-control': 'no-store',
      ...loginStorageHeaders(request, deps.sessions, account.spaceId, origin, [
        issuedPlatformCookie(deps.sessions, account, origin),
        ...cookies.map(cookie => secureDshCookie(mountedDshCookie(cookie, communitySpacePath(account.spaceId)), origin)),
      ]),
    })
    response.end()
  }
  return {
    enter: async (request: IncomingMessage, response: ServerResponse, username: string): Promise<void> => {
      const account = await deps.entry.account(username)
      response.writeHead(303, { location: communitySpacePath(account.spaceId), 'cache-control': 'no-store' })
      response.end()
    },
    loginForm: (request: IncomingMessage, response: ServerResponse): void => {
      const { locale, preference } = requestLanguage(request)
      sendHtml(response, 200, communityLoginPage(undefined, locale, preference))
    },
    bootstrap: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const { locale, preference } = requestLanguage(request)
      if (deps.recordsReady?.() !== false && (await deps.onboarding.bootstrapComplete())) {
        sendHtml(response, 404, communityBootstrapClosedPage(locale, preference))
        return
      }
      if (request.method === 'GET') {
        sendHtml(response, 200, communityBootstrapPage(undefined, locale, preference))
        return
      }
      if (request.method !== 'POST') {
        sendText(response, 405, 'Method Not Allowed')
        return
      }
      assertCommunityOrigin(request, deps.origin())
      const form = await readCommunityForm(request)
      const invitation = form.get('credential') ?? '',
        action = form.get('action')
      if (action === 'database-authorize') {
        deps.onboarding.authorizeBootstrap(invitation)
        sendCommunityJson(response, 200, { html: deps.databaseOnboarding?.pending() ? communityDatabaseForm(locale) : communityAdministratorForm(locale) })
        return
      }
      if (action === 'database-test' || action === 'database-select') {
        deps.onboarding.authorizeBootstrap(invitation)
        if (!deps.databaseOnboarding) {
          sendText(response, 503, 'Database initialization is unavailable')
          return
        }
        const kind = form.get('databaseKind') ?? 'builtin'
        if (kind !== 'builtin' && kind !== 'external')
          throw new BusinessRuleError('invalid', 'Invalid platform database selection', 'database-connection-invalid')
        const connection =
          kind === 'builtin'
            ? undefined
            : requestedPlatformDatabaseConnection({
                host: form.get('databaseHost') ?? '',
                port: form.get('databasePort') ?? '',
                database: form.get('databaseName') ?? '',
                username: form.get('databaseUsername') ?? '',
                password: form.get('databasePassword') ?? '',
                tls: form.get('databaseTls') ?? 'disable',
                ca: form.get('databaseCa') ?? '',
              })
        if (action === 'database-test') {
          sendCommunityJson(response, 200, await deps.databaseOnboarding.test(invitation, connection))
          return
        }
        await deps.databaseOnboarding.select(invitation, connection)
        sendCommunityJson(response, 200, { html: communityAdministratorForm(locale) })
        return
      }
      if (deps.recordsReady?.() === false) {
        if (!deps.databaseOnboarding) {
          sendText(response, 503, 'Database initialization is unavailable')
          return
        }
        await deps.databaseOnboarding.resume(form.get('credential') ?? '')
      }
      const account = await deps.onboarding.bootstrap(form.get('credential') ?? '', {
        username: form.get('username') ?? '',
        email: form.get('email') ?? '',
        password: form.get('password') ?? '',
      })
      signedIn(request, response, deps.origin(), account, [])
    },
    login: async (request: IncomingMessage, response: ServerResponse, origin: URL): Promise<void> => {
      assertCommunityOrigin(request, origin)
      const form = await readCommunityForm(request)
      const { account, cookies } = await deps.entry.signIn(form.get('username') ?? '', form.get('password') ?? '')
      signedIn(request, response, origin, account, cookies)
    },
  }
}
