import type { BrowserContext, Page } from 'playwright'
import { expect } from 'vitest'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rmdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { installedShellArgument, installedUserDataRoot } from './installed-storage-layout.js'

type SavedSession = { path: string; sha256: string }
const digest = (bytes: string) => createHash('sha256').update(bytes).digest('hex')

function sessionCookies(bytes: string, origin: string) {
  try {
    const saved = JSON.parse(bytes) as { origin: string; cookies: Awaited<ReturnType<BrowserContext['cookies']>> }
    if (saved.origin === origin && saved.cookies.length === 1 && saved.cookies[0]?.name === 'dsh-phalanx_session' && saved.cookies[0].value.length > 0)
      return saved.cookies
  } catch {
    // Parser errors may quote bearer bytes; only a credential-free diagnostic may escape.
  }
  throw Error('Invalid saved baseline browser session')
}

async function privateSessionFile(path: string) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o600) throw Error('Invalid private upgrade browser session file')
    return await file.readFile('utf8')
  } finally {
    await file.close()
  }
}

/** Credentials stay outside evidence/artifact directories; progress contains only their path and digest. */
export async function saveUpgradeSession(member: Page, progressPath: string, origin: string): Promise<SavedSession> {
  const directory = join('/var/tmp', 'phalanx-upgrade-browser-' + digest(progressPath))
  await mkdir(directory, { mode: 0o700, recursive: true })
  const info = await lstat(directory)
  if (!info.isDirectory() || info.uid !== process.getuid?.() || (info.mode & 0o777) !== 0o700) throw Error('Invalid private upgrade browser session directory')
  const path = join(directory, 'session.json')
  let previous: string | undefined
  try {
    previous = await privateSessionFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (previous !== undefined) {
    sessionCookies(previous, origin)
    return { path, sha256: digest(previous) }
  }
  expect(
    (await member.request.post(origin + '/login', { headers: { origin }, form: { username: 'member', password: 'password' }, maxRedirects: 0 })).status(),
  ).toBe(303)
  const cookies = (await member.context().cookies(origin)).filter(cookie => cookie.name === 'dsh-phalanx_session')
  expect(cookies.length, 'Capture the baseline member login before applying the upgrade').toBe(1)
  const bytes = JSON.stringify({ origin, cookies })
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(bytes)
    await file.sync()
  } finally {
    await file.close()
  }
  return { path, sha256: digest(bytes) }
}

export async function removeUpgradeSession(saved: SavedSession) {
  let bytes: string
  try {
    bytes = await privateSessionFile(saved.path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  expect(digest(bytes) === saved.sha256, 'Only remove the owned browser-session file').toBe(true)
  await unlink(saved.path)
  await rmdir(dirname(saved.path))
}

/** The baseline browser's original session remains authoritative beside a newly remembered account. */
async function assertLegacyUpgradeSession({ admin, member, origin, memberEntry }: { admin: Page; member: Page; origin: string; memberEntry: string }) {
  const session = (await member.context().cookies(origin)).find(cookie => cookie.name === 'dsh-phalanx_session')
  expect(Boolean(session), 'The original baseline member login must still be present').toBe(true)
  const oldList = await member.request.get(origin + '/account/signed-in')
  expect(oldList.status()).toBe(200)
  expect(await oldList.json()).toEqual({ accounts: [] })

  // A separate administrator login obtains the new signed cookie through the public entry.
  expect(
    (await admin.request.post(origin + '/login', { headers: { origin }, form: { username: 'admin', password: 'password' }, maxRedirects: 0 })).status(),
  ).toBe(303)
  const remembered = (await admin.context().cookies(origin)).find(cookie => cookie.name === 'dsh-phalanx_signed_in_accounts')
  expect(Boolean(remembered), 'The target login must issue the remembered-account cookie').toBe(true)
  await member.context().addCookies([remembered!])
  const list = await member.request.get(origin + '/account/signed-in')
  expect(list.status()).toBe(200)
  expect(await list.json()).toMatchObject({ accounts: [{ username: 'admin', status: 'available' }] })
  const stillOriginal = (await member.context().cookies(origin)).find(cookie => cookie.name === 'dsh-phalanx_session')
  expect(stillOriginal?.value === session?.value, 'Remembering another account must not replace the original session').toBe(true)

  await member.goto(origin + memberEntry, { timeout: 300000 })
  await member.waitForURL(url => url.origin === origin && url.pathname === memberEntry, { timeout: 300000 })
  await member.locator('#root').waitFor({ state: 'attached', timeout: 600000 })
  expect((await member.request.get(origin + '/admin/api/accounts', { maxRedirects: 0 })).status()).toBe(403)
  return { originalSessionRetained: true, rememberedCookiePresent: true, memberEntered: true, administratorAccessRefused: true }
}

/** A resumed enter stage restores the exact original baseline session before testing the target. */
export async function enterUpgradedMember({
  admin,
  member,
  origin,
  memberEntry,
  remote,
  candidate,
  browserSession,
}: {
  admin: Page
  member: Page
  origin: string
  memberEntry: string
  remote: (command: string) => Promise<string>
  candidate: string
  browserSession: SavedSession
}) {
  expect(JSON.parse(await remote('sudo cat /opt/dsh-phalanx/current/build-info.json')).commit).toBe(candidate)
  const bytes = await privateSessionFile(browserSession.path)
  expect(digest(bytes) === browserSession.sha256, 'The original baseline session must match its recorded digest').toBe(true)
  await member.context().clearCookies()
  await member.context().addCookies(sessionCookies(bytes, origin))
  const legacySession = await assertLegacyUpgradeSession({ admin, member, origin, memberEntry })
  await member.context().clearCookies()
  await member.goto(origin + '/login')
  await member.getByLabel('Username', { exact: true }).fill('member')
  await member.getByLabel('Password', { exact: true }).fill('password')
  const submitted = member.waitForResponse(response => new URL(response.url()).pathname === '/login' && response.request().method() === 'POST', {
    timeout: 300000,
  })
  await member.getByRole('button', { name: 'Sign in', exact: true }).click({ noWaitAfter: true })
  expect((await submitted).status()).toBe(303)
  await member.waitForURL(url => url.origin === origin && url.pathname === memberEntry, { timeout: 300000 })
  await member.locator('#root').waitFor({ state: 'attached', timeout: 600000 })
  expect(await remote('sudo cat ' + installedShellArgument((await installedUserDataRoot(remote)) + '/member/home/upgrade-owned.txt'))).toBe(
    'MEMBER_DATA_PRESERVED',
  )
  return { loginStatus: 303, memberEntry, rootAttached: true, memberFilePreserved: true, coldEntryAfterUpgrade: true, legacySession }
}
