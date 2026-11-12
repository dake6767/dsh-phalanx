import type { SignedInAccountStatus, SignedInAccountView } from '../domain/admin-contract.js'
import type { CommunityAccountRecord } from '../domain/community-account.js'
import type { IncomingMessage } from 'node:http'
import { parseCookie, serializeCookie } from 'cookie-es'
import { timingSafeEqual } from 'node:crypto'
import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { PLATFORM_COOKIE, SIGNED_IN_ACCOUNTS_COOKIE, type PlatformSessionCodec, type VerifiedSession } from './platform-session.js'

export const MAX_SIGNED_IN_ACCOUNTS = 10

/** One remembered account: its durable space marker plus that login's session token. */
export interface SignedInAccountEntry {
  readonly userId: string
  readonly marker: string
  readonly token?: string
}

const encode = (value: string): string => deflateRawSync(Buffer.from(value)).toString('base64url')

const isEntryShape = (value: unknown): value is [string, string] | [string, string, string] =>
  Array.isArray(value) &&
  (value.length === 2 || value.length === 3) &&
  typeof value[0] === 'string' &&
  value[0].length > 0 &&
  typeof value[1] === 'string' &&
  value[1].length > 0 &&
  (value.length === 2 || typeof value[2] === 'string')

/** Read the remembered-account list; a tampered cookie is discarded whole, dead tokens entry by entry. */
export function readSignedInAccounts(sessions: PlatformSessionCodec, cookieHeader: string | undefined): SignedInAccountEntry[] {
  const cookie = cookieHeader === undefined ? undefined : parseCookie(cookieHeader)[SIGNED_IN_ACCOUNTS_COOKIE]
  if (cookie === undefined) return []
  const [body, signature, extra] = cookie.split('.')
  if (body === undefined || signature === undefined || extra !== undefined) return []
  const actual = Buffer.from(signature, 'base64url')
  const expected = Buffer.from(sessions.sign(body), 'base64url')
  if (actual.byteLength !== expected.byteLength || !timingSafeEqual(actual, expected)) return []
  let payload: unknown
  try {
    payload = JSON.parse(inflateRawSync(Buffer.from(body, 'base64url'), { maxOutputLength: 32_768 }).toString('utf8'))
  } catch {
    return []
  }
  if (typeof payload !== 'object' || payload === null) return []
  const candidate = payload as { version?: unknown; entries?: unknown }
  if (candidate.version !== 1 || !Array.isArray(candidate.entries) || candidate.entries.length > MAX_SIGNED_IN_ACCOUNTS) return []
  const entries: SignedInAccountEntry[] = []
  for (const value of candidate.entries) {
    if (!isEntryShape(value)) return []
    // A token that no longer verifies is dropped; the entry keeps its durable marker.
    entries.push({ userId: value[0], marker: value[1], ...(value.length === 3 && sessions.verify(value[2]) !== undefined ? { token: value[2] } : {}) })
  }
  return entries
}

export function serializeSignedInAccountsCookie(sessions: PlatformSessionCodec, entries: readonly SignedInAccountEntry[], origin: URL): string {
  const body = encode(
    JSON.stringify({ version: 1, entries: entries.map(entry => [entry.userId, entry.marker, ...(entry.token === undefined ? [] : [entry.token])]) }),
  )
  return serializeCookie(SIGNED_IN_ACCOUNTS_COOKIE, `${body}.${sessions.sign(body)}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: origin.protocol === 'https:',
    path: '/',
    maxAge: 365 * 24 * 60 * 60,
  })
}

export function clearedSignedInAccountsCookie(origin: URL): string {
  return serializeCookie(SIGNED_IN_ACCOUNTS_COOKIE, '', {
    httpOnly: true,
    sameSite: 'strict',
    secure: origin.protocol === 'https:',
    path: '/',
    maxAge: 0,
  })
}

/** Rebuild the list after a successful login; a full list refuses to remember another account. */
export function upsertSignedInAccount(
  sessions: PlatformSessionCodec,
  cookieHeader: string | undefined,
  account: CommunityAccountRecord,
  token: string,
  preserved?: SignedInAccountEntry,
): readonly SignedInAccountEntry[] | 'full' {
  const entries = readSignedInAccounts(sessions, cookieHeader).filter(candidate => candidate.marker !== sessions.storageAccountMarker(account.spaceId))
  if (preserved && preserved.marker !== sessions.storageAccountMarker(account.spaceId)) {
    const index = entries.findIndex(entry => entry.marker === preserved.marker)
    if (index === -1) entries.push(preserved)
    else entries[index] = preserved
  }
  if (entries.length >= MAX_SIGNED_IN_ACCOUNTS) return 'full'
  return [{ userId: account.username, marker: sessions.storageAccountMarker(account.spaceId), token }, ...entries]
}

/** Resolve display facts for every remembered entry against the durable account store. */
export async function signedInAccountViews(
  sessions: PlatformSessionCodec,
  entries: readonly SignedInAccountEntry[],
  current: VerifiedSession | undefined,
  accountFor: (username: string) => Promise<CommunityAccountRecord | undefined>,
): Promise<readonly SignedInAccountView[]> {
  const currentMarker = current === undefined ? undefined : sessions.storageAccountMarker(current.spaceId)
  const views: SignedInAccountView[] = []
  for (const entry of entries) {
    const account = await accountFor(entry.userId)
    const session = entry.token === undefined ? undefined : sessions.verify(entry.token)
    const status: SignedInAccountStatus =
      account === undefined || sessions.storageAccountMarker(account.spaceId) !== entry.marker || account.disabled
        ? 'unavailable'
        : session === undefined || session.userId !== entry.userId || session.spaceId !== account.spaceId || session.sessionEpoch !== account.sessionEpoch
          ? 'reauthentication-required'
          : currentMarker === entry.marker && current?.sessionEpoch === account.sessionEpoch
            ? 'current'
            : 'available'
    views.push({
      username: entry.userId,
      admin: account !== undefined && sessions.storageAccountMarker(account.spaceId) === entry.marker && account.admin,
      status,
      marker: entry.marker,
    })
  }
  return views
}

/** The verified session of this browser's current login, if any. */
export function currentSignedInSession(sessions: PlatformSessionCodec, request: IncomingMessage): VerifiedSession | undefined {
  return sessions.verify(parseCookie(request.headers.cookie ?? '')[PLATFORM_COOKIE])
}
