import { accountChangeCookie } from './account-change-cookie.js'
import { platformPage, htmlText } from './platform-page.js'
import { platformText } from '../domain/platform-copy.js'
import { requestLanguage } from './platform-language.js'
import { sendHtml } from './http-response.js'
import type { SignedInAccountView } from '../domain/admin-contract.js'
import type { CommunityAccountRecord } from '../domain/community-account.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { CommunityEntry } from '../use-cases/community-entry.js'
import { communitySpacePath } from '../domain/community-space.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseCookie, serializeCookie } from 'cookie-es'
import { assertCommunityOrigin, readCommunityForm } from './community-request.js'
import { sendCommunityJson } from './community-errors.js'
import { clearedPlatformCookie, LAST_ACCOUNT_COOKIE, platformSessionCookie, type PlatformSessionCodec } from './platform-session.js'
import {
  clearedSignedInAccountsCookie,
  currentSignedInSession,
  readSignedInAccounts,
  serializeSignedInAccountsCookie,
  signedInAccountViews,
  upsertSignedInAccount,
  type SignedInAccountEntry,
} from './platform-signed-in-accounts.js'

/** Remembered accounts: cookie maintenance plus the switch, remove and sign-out-all endpoints. */
export function createSignedInAccountRoutes(deps: {
  readonly sessions: PlatformSessionCodec
  readonly accounts: Pick<CommunityAccountReaderPort, 'get'>
  readonly entry: Pick<CommunityEntry, 'forgetRuntimeSession'>
  readonly origin: () => URL
}) {
  const entriesOf = (request: IncomingMessage) => readSignedInAccounts(deps.sessions, request.headers.cookie)
  const views = async (request: IncomingMessage): Promise<readonly SignedInAccountView[]> =>
    await signedInAccountViews(deps.sessions, entriesOf(request), currentSignedInSession(deps.sessions, request), deps.accounts.get.bind(deps.accounts))
  const withoutToken = (entries: readonly SignedInAccountEntry[], index: number): SignedInAccountEntry[] =>
    entries.map((entry, at) => (at === index ? { userId: entry.userId, marker: entry.marker } : entry))
  const redirectWith = (response: ServerResponse, origin: URL, entries: readonly SignedInAccountEntry[], location: string): void => {
    response.writeHead(303, { location, 'cache-control': 'no-store', 'set-cookie': [serializeSignedInAccountsCookie(deps.sessions, entries, origin)] })
    response.end()
  }
  return {
    /** A separate document unloads the previous page and all its live connections. */
    notice: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      const session = currentSignedInSession(deps.sessions, request)
      const account = session === undefined ? undefined : await deps.accounts.get(session.userId)
      const valid = account !== undefined && !account.disabled && account.spaceId === session?.spaceId && account.sessionEpoch === session?.sessionEpoch
      const { locale, preference } = requestLanguage(request)
      const title = platformText(locale, 'Account changed')
      const message = valid
        ? platformText(locale, 'This browser switched to account {username}.', { username: account.username })
        : platformText(locale, 'This browser signed out.')
      const target = valid ? (account.admin ? '/admin' : communitySpacePath(account.spaceId)) : '/login'
      sendHtml(
        response,
        200,
        platformPage(
          title,
          `<section role="alertdialog" aria-modal="true" aria-label="${title}"><h1>${htmlText(message)}</h1><a id="continue" href="${target}">${platformText(locale, 'Go')}</a></section>`,
          "document.getElementById('continue').focus()",
          undefined,
          locale,
          preference,
        ),
      )
    },
    /** Display facts for the server-rendered login page. */
    loginChoices: views,
    /** Cookie for a successful login, or the cap marker when the browser already remembers ten accounts. */
    forLogin(request: IncomingMessage, account: CommunityAccountRecord, token: string): string | 'full' {
      const updated = upsertSignedInAccount(deps.sessions, request.headers.cookie, account, token)
      return updated === 'full' ? 'full' : serializeSignedInAccountsCookie(deps.sessions, updated, deps.origin())
    },
    list: async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
      sendCommunityJson(response, 200, { accounts: await views(request) })
    },
    switchAccount: async (request: IncomingMessage, response: ServerResponse, origin: URL): Promise<void> => {
      assertCommunityOrigin(request, origin)
      const form = await readCommunityForm(request)
      const entries = entriesOf(request)
      const index = entries.findIndex(entry => entry.marker === form.get('marker'))
      if (index === -1) {
        redirectWith(response, origin, entries, '/login')
        return
      }
      const entry = entries[index]
      const account = entry === undefined ? undefined : await deps.accounts.get(entry.userId)
      if (entry === undefined || account === undefined || account.disabled || deps.sessions.storageAccountMarker(account.spaceId) !== entry.marker) {
        // Deleted, recreated or disabled: the entry stays listed for removal but loses its token.
        redirectWith(response, origin, withoutToken(entries, index), '/login')
        return
      }
      const session = entry.token === undefined ? undefined : deps.sessions.verify(entry.token)
      if (
        entry.token === undefined ||
        session === undefined ||
        session.userId !== entry.userId ||
        session.spaceId !== account.spaceId ||
        session.sessionEpoch !== account.sessionEpoch
      ) {
        redirectWith(response, origin, withoutToken(entries, index), `/login?username=${encodeURIComponent(entry.userId)}`)
        return
      }
      deps.entry.forgetRuntimeSession(entry.userId)
      const lastMarker = deps.sessions.storageAccountMarker(account.spaceId)
      const previous = parseCookie(request.headers.cookie ?? '')[LAST_ACCOUNT_COOKIE]
      response.writeHead(303, {
        location: account.admin ? '/admin' : communitySpacePath(account.spaceId),
        'cache-control': 'no-store',
        // Switching reuses the remembered token verbatim: no new session is minted or extended.
        ...(previous === lastMarker ? {} : { 'clear-site-data': '"storage"' }),
        'set-cookie': [
          accountChangeCookie('switched', origin),
          platformSessionCookie(entry.token, Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000)), origin),
          serializeSignedInAccountsCookie(
            deps.sessions,
            [{ userId: entry.userId, marker: entry.marker, token: entry.token }, ...entries.filter((_, at) => at !== index)],
            origin,
          ),
          serializeCookie(LAST_ACCOUNT_COOKIE, lastMarker, {
            httpOnly: true,
            sameSite: 'strict',
            secure: origin.protocol === 'https:',
            path: '/',
            maxAge: 365 * 24 * 60 * 60,
          }),
        ],
      })
      response.end()
    },
    remove: async (request: IncomingMessage, response: ServerResponse, origin: URL): Promise<void> => {
      assertCommunityOrigin(request, origin)
      const form = await readCommunityForm(request)
      const marker = form.get('marker') ?? ''
      const entries = entriesOf(request).filter(entry => entry.marker !== marker)
      response.writeHead(303, {
        location: '/login',
        'cache-control': 'no-store',
        'set-cookie': [entries.length === 0 ? clearedSignedInAccountsCookie(origin) : serializeSignedInAccountsCookie(deps.sessions, entries, origin)],
      })
      response.end()
    },
    removeAll: async (request: IncomingMessage, response: ServerResponse, origin: URL): Promise<void> => {
      assertCommunityOrigin(request, origin)
      response.writeHead(303, {
        location: '/login',
        'cache-control': 'no-store',
        'set-cookie': [clearedSignedInAccountsCookie(origin), clearedPlatformCookie(origin), accountChangeCookie('signed-out-all', origin)],
      })
      response.end()
    },
    /** Log out keeps the entry listed but takes its token away; the user signs in again to use it. */
    logoutRewrite(request: IncomingMessage, origin: URL): string | undefined {
      const current = currentSignedInSession(deps.sessions, request)
      if (current === undefined) return undefined
      const marker = deps.sessions.storageAccountMarker(current.spaceId)
      const entries = entriesOf(request)
      const index = entries.findIndex(entry => entry.marker === marker)
      return index === -1 ? undefined : serializeSignedInAccountsCookie(deps.sessions, withoutToken(entries, index), origin)
    },
  }
}

export type SignedInAccountRoutes = ReturnType<typeof createSignedInAccountRoutes>
