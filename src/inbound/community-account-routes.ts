import { accountChangeCookie } from './account-change-cookie.js'
import { currentSignedInSession } from './platform-signed-in-accounts.js'
import { requestedPlatformDatabaseConnection } from '../domain/platform-database.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityDatabaseOnboarding } from '../use-cases/community-database-onboarding.js'
import { communityDatabaseForm } from './community-database-page.js'
import { sendCommunityJson } from './community-errors.js'
import { requestLanguage } from './platform-language.js'
import { platformError } from '../domain/platform-copy.js'
import { communitySpacePath } from '../domain/community-space.js'
import type { CommunityAccountRecord } from '../domain/community-account.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CommunityEntry } from '../use-cases/community-entry.js'
import type { CommunityOnboarding } from '../use-cases/community-onboarding.js'
import { assertCommunityOrigin, readCommunityForm } from './community-request.js'
import { communityAdministratorForm, communityBootstrapClosedPage, communityBootstrapPage, communityLoginPage } from './community-account-pages.js'
import { sendHtml, sendText } from './http-response.js'
import { platformSessionCookie, loginStorageHeaders, mountedDshCookie, secureDshCookie, type PlatformSessionCodec } from './platform-session.js'
import type { SignedInAccountRoutes } from './signed-in-account-routes.js'

export function communityAccountRoutes(deps: {
  readonly databaseOnboarding?: CommunityDatabaseOnboarding
  readonly recordsReady?: () => boolean
  readonly onboarding: CommunityOnboarding
  readonly entry: CommunityEntry
  readonly sessions: PlatformSessionCodec
  readonly origin: () => URL
  readonly signedInAccounts: SignedInAccountRoutes
}) {
  /** A successful sign in remembers the account; bootstrap of a fresh installation never depends on stale cookies. */
  const signedIn = async (
    request: IncomingMessage,
    response: ServerResponse,
    origin: URL,
    account: CommunityAccountRecord,
    cookies: readonly string[],
    remember: 'remembered-accounts' | 'bootstrap',
  ): Promise<void> => {
    const token = deps.sessions.issue(account)
    const remembered = deps.signedInAccounts.forLogin(request, account, token)
    if (remembered === 'full' && remember === 'remembered-accounts') {
      // The browser already remembers ten accounts; none is displaced and the sign-in is refused.
      const { locale, preference } = requestLanguage(request)
      sendHtml(
        response,
        403,
        communityLoginPage(
          platformError(locale, {
            code: 'signed-in-accounts-full',
            error: 'This browser already remembers 10 accounts. Remove one before signing in to another.',
          }),
          locale,
          preference,
          await deps.signedInAccounts.loginChoices(request),
        ),
      )
      return
    }
    response.writeHead(303, {
      location: account.admin ? '/admin' : communitySpacePath(account.spaceId),
      'cache-control': 'no-store',
      ...loginStorageHeaders(request, deps.sessions, account.spaceId, origin, [
        platformSessionCookie(token, deps.sessions.maxAgeSeconds, origin),
        ...(currentSignedInSession(deps.sessions, request)?.spaceId === account.spaceId ? [] : [accountChangeCookie('switched', origin)]),
        // Bootstrap of a fresh installation proceeds without remembering when the list is full.
        ...(remembered === 'full' ? [] : [remembered]),
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
    loginForm: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const { locale, preference } = requestLanguage(request)
      const query = new URL(request.url ?? '/', deps.origin()).searchParams
      const other = query.get('other')
      const username = query.get('username')
      const choices = other === null && username === null ? await deps.signedInAccounts.loginChoices(request) : []
      const accounts = query.has('accounts') || choices.some(account => account.status === 'available' || account.status === 'current') ? choices : []
      sendHtml(response, 200, communityLoginPage(undefined, locale, preference, accounts, username === null ? undefined : username, choices.length > 0))
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
      await signedIn(request, response, deps.origin(), account, [], 'bootstrap')
    },
    login: async (request: IncomingMessage, response: ServerResponse, origin: URL): Promise<void> => {
      assertCommunityOrigin(request, origin)
      const form = await readCommunityForm(request)
      const { account, cookies } = await deps.entry.signIn(form.get('username') ?? '', form.get('password') ?? '')
      await signedIn(request, response, origin, account, cookies, 'remembered-accounts')
    },
  }
}
