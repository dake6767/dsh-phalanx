import type { PlatformSigningKeyPort } from '../ports/platform-signing-key.js'
import { PLATFORM_LANGUAGE_COOKIE } from '../domain/platform-language.js'
import type { PreviewIdentity } from '../ports/service-preview.js'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { CommunityAccountState } from '../domain/community-account.js'
import type { CommunityAccountStatePort } from '../ports/community-accounts.js'
import type { IncomingMessage } from 'node:http'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import { parseCookie, serializeCookie, stringifyCookie } from 'cookie-es'

const PLATFORM_COOKIE = 'dsh-phalanx_session'
const LAST_ACCOUNT_COOKIE = 'dsh-phalanx_last_account'

const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000

interface SessionPayload {
  readonly version: 3
  readonly userId: string
  readonly spaceId: string
  readonly sessionEpoch: number
  readonly expiresAt: number
}

/** Verified contents of one platform-session bearer value. */
export interface VerifiedSession {
  readonly expiresAt: number
  readonly userId: string
  readonly spaceId: string
  readonly sessionEpoch: number
}

const encode = (value: string): string => Buffer.from(value).toString('base64url')

/** Signed, stateless platform-session codec.
 *
 * Each session is minted at the account's current session-invalidation epoch;
 * the application re-checks that epoch against the account store on every
 * use, so a password change or disable kills every outstanding session. */
export class PlatformSessionCodec {
  readonly maxAgeSeconds = Math.floor(SESSION_LIFETIME_MS / 1000)

  /** @param secret - initialized platform key owner, or an explicit key for an isolated codec. */
  constructor(private readonly secret: string | PlatformSigningKeyPort) {
    if (typeof secret === 'string' && Buffer.byteLength(secret) < 32) throw new Error('session secret must contain at least 32 bytes')
  }

  /** @param userId - stable internal user identity. @returns signed bearer value. */
  issue(account: CommunityAccountState): string {
    const payload: SessionPayload = {
      version: 3,
      userId: account.username,
      spaceId: account.spaceId,
      sessionEpoch: account.sessionEpoch,
      expiresAt: Date.now() + SESSION_LIFETIME_MS,
    }
    const body = encode(JSON.stringify(payload))
    return `${body}.${this.signature(body)}`
  }

  /** Opaque, deployment-scoped identity for the browser's last successful login. */
  storageAccountMarker(userId: string): string {
    return this.signature(`dsh-phalanx:browser-storage:v1:${userId}`)
  }

  /** @param token - untrusted cookie value. @returns verified session, if valid. */
  verify(token: string | undefined): VerifiedSession | undefined {
    if (token === undefined) return undefined
    const [body, signature, extra] = token.split('.')
    if (body === undefined || signature === undefined || extra !== undefined) return undefined
    const actual = Buffer.from(signature, 'base64url')
    const expected = Buffer.from(this.signature(body), 'base64url')
    if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return undefined
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    } catch {
      return undefined
    }
    if (!isSessionPayload(payload) || payload.expiresAt <= Date.now()) return undefined
    return { userId: payload.userId, spaceId: payload.spaceId, sessionEpoch: payload.sessionEpoch, expiresAt: payload.expiresAt }
  }

  private signature(body: string): string {
    return createHmac('sha256', typeof this.secret === 'string' ? this.secret : this.secret.read())
      .update(body)
      .digest('base64url')
  }
}

/** Recheck the durable account epoch and disabled flag on every entry request. */
export async function authenticatedUser(
  request: IncomingMessage,
  sessions: PlatformSessionCodec,
  accountFor: (userId: string) => Promise<CommunityAccountState | undefined>,
): Promise<string | undefined> {
  const cookie = request.headers.cookie
  if (cookie === undefined) return undefined
  const session = sessions.verify(parseCookie(cookie)[PLATFORM_COOKIE])
  if (session === undefined) return undefined
  const account = await accountFor(session.userId)
  return account === undefined || account.disabled || account.spaceId !== session.spaceId || account.sessionEpoch !== session.sessionEpoch
    ? undefined
    : session.userId
}

/** One entry's account identity and durable revocation checks. */
export interface EntrySessionGate {
  authenticate(request: IncomingMessage): Promise<string | undefined>
  current(request: IncomingMessage, userId: string): Promise<boolean>
  admit(request: IncomingMessage, userId: string, register: (onAbort: (cleanup: () => void) => void) => boolean): Promise<boolean>
}

class EntryRegistrationRejected extends Error {}

/** The durable identity fence owns reversible registration, before any HTTP bytes are emitted. */
export function createEntrySessionGate(sessions: PlatformSessionCodec, accounts: CommunityAccountStatePort): EntrySessionGate {
  const authenticate = async (request: IncomingMessage) => await authenticatedUser(request, sessions, accounts.getState.bind(accounts))
  const verified = (request: IncomingMessage) => sessions.verify(parseCookie(request.headers.cookie ?? '')[PLATFORM_COOKIE])
  return {
    authenticate,
    current: async (request, userId) => (await authenticate(request)) === userId,
    admit: async (request, userId, register) => {
      if (verified(request)?.userId !== userId) return false
      try {
        return await accounts.withCurrentState(userId, (account, onAbort) => {
          const current = verified(request)
          if (
            !current ||
            current.userId !== userId ||
            !account ||
            account.disabled ||
            account.spaceId !== current.spaceId ||
            account.sessionEpoch !== current.sessionEpoch
          )
            return false
          if (!register(onAbort)) throw new EntryRegistrationRejected()
          return true
        })
      } catch (error) {
        if (error instanceof EntryRegistrationRejected) return false
        throw error
      }
    },
  }
}

export function issuedPlatformCookie(sessions: PlatformSessionCodec, account: CommunityAccountState, origin: URL): string {
  return serializeCookie(PLATFORM_COOKIE, sessions.issue(account), {
    httpOnly: true,
    sameSite: 'strict',
    secure: origin.protocol === 'https:',
    path: '/',
    maxAge: sessions.maxAgeSeconds,
  })
}

export function clearedPlatformCookie(origin: URL): string {
  return serializeCookie(PLATFORM_COOKIE, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: origin.protocol === 'https:',
    path: '/',
    maxAge: 0,
  })
}

/** Storage clearing accompanies a successful login only, and never clears cookies. */
export function loginStorageHeaders(
  request: IncomingMessage,
  sessions: PlatformSessionCodec,
  userId: string,
  origin: URL,
  loginCookies: readonly string[],
): Record<string, string | string[]> {
  const marker = sessions.storageAccountMarker(userId)
  const previous = parseCookie(request.headers.cookie ?? '')[LAST_ACCOUNT_COOKIE]
  return {
    ...(previous === marker ? {} : { 'clear-site-data': '"storage"' }),
    'set-cookie': [
      ...loginCookies,
      serializeCookie(LAST_ACCOUNT_COOKIE, marker, {
        httpOnly: true,
        sameSite: 'strict',
        secure: origin.protocol === 'https:',
        path: '/',
        maxAge: 365 * 24 * 60 * 60,
      }),
    ],
  }
}

/** DSH cookies belong to the authenticated space even when the origin emits Path=/. */
export function mountedDshCookie(cookie: string, mount: string): string {
  return /(?:^|;)\s*Path=/iu.test(cookie) ? cookie.replace(/((?:^|;)\s*Path=)[^;]*/iu, `$1${mount}`) : `${cookie}; Path=${mount}`
}

export function secureDshCookie(cookie: string, origin: URL): string {
  if (origin.protocol !== 'https:' || /(?:^|;)\s*Secure(?:;|$)/iu.test(cookie)) return cookie
  return `${cookie}; Secure`
}

/** Remove the platform credential before forwarding a request to DSH. */
export function stripPlatformCookie(request: IncomingMessage): void {
  if (request.headers.cookie === undefined) return
  const cookies = parseCookie(request.headers.cookie)
  delete cookies[PLATFORM_COOKIE]
  delete cookies[LAST_ACCOUNT_COOKIE]
  delete cookies[PLATFORM_LANGUAGE_COOKIE]
  const forwarded = stringifyCookie(cookies)
  if (forwarded === '') delete request.headers.cookie
  else request.headers.cookie = forwarded
}

export function runtimeCookie(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  const cookies = parseCookie(header)
  delete cookies[PLATFORM_COOKIE]
  delete cookies[LAST_ACCOUNT_COOKIE]
  delete cookies[PLATFORM_LANGUAGE_COOKIE]
  const forwarded = stringifyCookie(cookies)
  return forwarded === '' ? undefined : forwarded
}

export function rememberRuntimeCookie(sessions: SessionRegistryPort, userId: string, header: string | undefined): void {
  const cookie = runtimeCookie(header)
  if (cookie !== undefined) sessions.rememberRuntimeCookie(userId, cookie)
}

function isSessionPayload(value: unknown): value is SessionPayload {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<SessionPayload>
  return (
    candidate.version === 3 &&
    typeof candidate.spaceId === 'string' &&
    candidate.spaceId.length > 0 &&
    typeof candidate.userId === 'string' &&
    candidate.userId.length > 0 &&
    typeof candidate.sessionEpoch === 'number' &&
    Number.isSafeInteger(candidate.sessionEpoch) &&
    candidate.sessionEpoch >= 0 &&
    Number.isSafeInteger(candidate.expiresAt)
  )
}

/** Preview revocation uses a digest of this login without retaining bearer cookies. */
export function previewIdentity(request: IncomingMessage, sessions: PlatformSessionCodec): PreviewIdentity | undefined {
  const token = parseCookie(request.headers.cookie ?? '')[PLATFORM_COOKIE]
  const identity = sessions.verify(token)
  return identity && token ? { ...identity, key: createHash('sha256').update(token).digest('hex') } : undefined
}
