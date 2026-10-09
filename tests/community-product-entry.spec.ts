import { communityEntryUrl } from './support/community-space.js'
import { mkdtemp, readdir, readFile, rm, rename, access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { hashPassword } from '../src/domain/password.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'

describe('community public product entry', () => {
  let application: CommunityApplication | undefined
  let root: string | undefined
  afterEach(async () => { await application?.stop(); if (root !== undefined) await rm(root, { recursive: true, force: true }); root = undefined; application = undefined })
  const start = async (sessionSecret = 'community-fixture-session-secret-with-32-bytes', userDataRoot?: string, runtimeCommand = process.execPath): Promise<string> => {
    root ??= await mkdtemp(join(tmpdir(), 'community-entry-'))
    application = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret,
      runtime: { command: runtimeCommand, args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))], dataRoot: root, ...(userDataRoot === undefined ? {} : { userDataRoot }),
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } } } })
    return await application.start()
  }
  const signIn = async (origin: string, username: string, password: string, enter = false): Promise<string> => {
    const response = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password }) })
    expect(response.status).toBe(303)
    let cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    if (enter && response.headers.get('location') === '/admin') {
      const opened = await fetch(`${origin}/enter`, { headers: { cookie }, redirect: 'manual' })
      expect(opened.status).toBe(303)
      cookie += '; ' + opened.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    }
    return cookie
  }
  it('creates the first administrator without email and immediately admits the issued login to management', async () => {
    const origin = await start(undefined, undefined, '/nonexistent-dsh-command')
    expect(await (await fetch(`${origin}/bootstrap`)).text()).not.toContain('name="email"')
    const credential = readBootstrapCredential(root!)!.credential
    const response = await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential, username: 'admin', password: 'password' }) })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/admin')
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    const session = await fetch(`${origin}/admin/api/session`, { headers: { cookie } })
    expect(session.status).toBe(200)
    expect(await session.json()).toMatchObject({ username: 'admin', admin: true, modelState: 'unconfigured' })
    expect((await fetch(`${origin}/bootstrap`)).status).toBe(404)
    const returning = await signIn(origin, 'admin', 'password')
    expect((await fetch(`${origin}/admin/api/session`, { headers: { cookie: returning } })).status).toBe(200)
  })
  it('keeps an outstanding initialization invitation valid across service restart', async () => {
    await start()
    const invitation = readBootstrapCredential(root!)!
    await application!.stop()
    const origin = await start()
    expect(readBootstrapCredential(root!)).toEqual(invitation)
    const response = await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: invitation.credential, username: 'admin', password: 'password' }) })
    expect(response.status).toBe(303)
    expect(response.headers.get('location')).toBe('/admin')
  })
  it('regenerates an initialization link through the operator command and invalidates the previous link', async () => {
    const origin = await start()
    const previous = readBootstrapCredential(root!)!.credential
    const command = ['--import', 'tsx',
      fileURLToPath(new URL('../src/composition/cli.ts', import.meta.url)), 'bootstrap-link',
      '--data-root', root!, '--origin', origin, '--renew']
    const { stdout } = await promisify(execFile)(process.execPath, command)
    const link = new URL(stdout.trim())
    expect(link.origin).toBe(origin)
    expect(link.pathname).toBe('/bootstrap')
    expect(link.search).toBe('')
    const renewed = new URLSearchParams(link.hash.slice(1)).get('credential')!
    expect(renewed).not.toBe(previous)
    for (const [credential, status] of [[previous, 403], [renewed, 303]] as const) {
      const response = await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ credential, username: 'admin', password: 'password' }) })
      expect(response.status).toBe(status)
    }
    expect((await promisify(execFile)(process.execPath, command)).stdout.trim()).toBe(`${origin}/admin`)
    expect(readBootstrapCredential(root!)).toBeUndefined()
    expect((await fetch(`${origin}/bootstrap`)).status).toBe(404)
  })
  it('bootstraps once, creates a non-admin member, rejects forged management and preserves access across restart', async () => {
    let origin = await start()
    const credential = readBootstrapCredential(root!)!.credential
    const page = await (await fetch(`${origin}/bootstrap`)).text()
    expect(page).not.toContain(credential)
    expect(page).not.toMatch(/group|preset/iu)
    const invalidBootstrap = await fetch(`${origin}/bootstrap`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: 'wrong-secret', username: 'intruder', email: 'intruder@example.test', password: 'private-password' }) })
    expect(invalidBootstrap.status).toBe(403)
    expect(await invalidBootstrap.text()).not.toMatch(/wrong-secret|private-password|intruder/iu)
    expect((await fetch(`${origin}/admin/api/accounts`)).status).toBe(401)
    const bootstrap = await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential, username: 'admin', email: 'admin@example.test', password: 'admin-password' }) })
    expect(bootstrap.status).toBe(303)
    expect(readBootstrapCredential(root!)).toBeUndefined()
    const adminCookie = await signIn(origin, 'admin', 'admin-password')
    for (const path of ['/admin/presets', '/admin/external', '/admin/records',
      '/admin/api/keys', '/admin/api/credentials', '/admin/api/records',
      '/account/records', '/account/connect/test', '/_dsh-phalanx/service/test', '/_dsh-phalanx/plugin/test']) {
      expect((await fetch(`${origin}${path}`, { headers: { cookie: adminCookie }, redirect: 'manual' })).status, path).toBe(404)
    }
    expect((await fetch(`${origin}/admin/api/groups`, { headers: { cookie: adminCookie } })).status).toBe(200)
    expect((await fetch(`${origin}/admin/api/plugins`, { headers: { cookie: adminCookie } })).status).toBe(200)
    const createRequest = (body: unknown, requestOrigin = origin) => fetch(`${origin}/admin/api/accounts`, {
      method: 'POST', headers: { cookie: adminCookie, origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    const input = { username: 'intruder', email: 'intruder@example.test', password: 'private-password' }
    expect((await createRequest({ ...input, admin: true })).status).toBe(400)
    expect((await createRequest({ ...input, group: 'default' })).status).toBe(400)
    expect((await createRequest(input, 'https://other.example.test')).status).toBe(403)
    expect((await createRequest({ ...input, password: 'x'.repeat(17 * 1024) })).status).toBe(413)
    expect((await fetch(`${origin}/healthz`)).status).toBe(200)
    const created = await fetch(`${origin}/admin/api/accounts`, { method: 'POST', headers: { cookie: adminCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member', email: 'member@example.test', password: 'member-password' }) })
    expect(created.status).toBe(201)
    const memberAccount = await created.json() as { username: string, admin: boolean, spaceId: string }
    expect(memberAccount).toMatchObject({ username: 'member', admin: false, spaceId: expect.any(String) })
    expect(memberAccount.spaceId).not.toBe('member')
    expect(memberAccount.spaceId.length).toBeGreaterThanOrEqual(24)
    const memberCookie = await signIn(origin, 'member', 'member-password')
    expect((await fetch(`${origin}/`, { headers: { cookie: memberCookie } })).status).toBe(200)
    expect((await fetch(`${origin}/admin/api/groups`, { headers: { cookie: memberCookie } })).status).toBe(403)
    expect((await fetch(`${origin}/admin/api/plugins`, { headers: { cookie: memberCookie } })).status).toBe(403)
    expect((await fetch(`${origin}/admin/api/plugins`, { method: 'POST', headers: { cookie: memberCookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'add', packageName: 'example-plugin', version: '1.0.0' }) })).status).toBe(403)
    expect((await fetch(`${origin}/admin/api/groups`, { method: 'POST', headers: { cookie: memberCookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'create', name: 'forbidden' }) })).status).toBe(403)
    expect((await fetch(`${origin}/admin/api/accounts`, { headers: { cookie: memberCookie } })).status).toBe(403)
    expect((await fetch(`${origin}/admin`, { headers: { cookie: memberCookie }, redirect: 'manual' })).status).toBe(403)
    expect((await fetch(`${origin}/admin/api/session`, { headers: { cookie: memberCookie } })).status).toBe(403)
    expect((await fetch(`${origin}/admin/api/accounts`, { method: 'POST', headers: { cookie: memberCookie, origin, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403)
    expect((await fetch(`${origin}/register`, { method: 'POST' })).status).toBe(404)
    expect((await fetch(`${origin}/signup`)).status).toBe(404)
    expect((await fetch(`${origin}/bootstrap`)).status).toBe(404)
    await application!.stop()
    origin = await start()
    expect(readBootstrapCredential(root!)).toBeUndefined()
    const restartedAdmin = await signIn(origin, 'admin', 'admin-password')
    const listing = await (await fetch(`${origin}/admin/api/accounts`, { headers: { cookie: restartedAdmin } })).json() as { items: { username: string, spaceId: string }[] }
    expect(listing.items.find(account => account.username === 'member')?.spaceId).toBe(memberAccount.spaceId)
    const restartedCookie = await signIn(origin, 'member', 'member-password')
    expect((await fetch(`${origin}/`, { headers: { cookie: restartedCookie } })).status).toBe(200)
    await application!.stop()
    expect((await readdir(root!)).sort()).toEqual(['community-accounts.db', 'environment-upgrades', 'managed-models', 'model-access.json', 'platform-lock.db', 'platform-plugin', 'shared-models.json', 'users'])
  })

  it('persists both members’ home and workspace under the configured user data root', async () => {
    const userDataRoot = await mkdtemp(join(tmpdir(), 'community-user-disk-'))
    try {
      let origin = await start(undefined, userDataRoot)
      const credential = readBootstrapCredential(root!)!.credential
      await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ credential, username: 'admin', email: 'admin@example.test', password: 'password' }) })
      const admin = await signIn(origin, 'admin', 'password', true)
      const created = await fetch(`${origin}/admin/api/accounts`, { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'member', email: 'member@example.test', password: 'password' }) })
      expect(created.status).toBe(201)
      for (const username of ['admin', 'member']) {
        const cookie = await signIn(origin, username, 'password', true)
        for (const location of ['home', 'workspace']) {
          expect((await fetch(`${communityEntryUrl(origin, cookie)}fixture/${location}-note`, { method: 'POST', headers: { cookie, origin }, body: `${username}-${location}` })).status).toBe(200)
          expect(await readFile(join(userDataRoot, username, location, 'fixture-note.txt'), 'utf8')).toBe(`${username}-${location}`)
        }
      }
      expect(await readdir(root!)).not.toContain('users')
      expect(await readdir(userDataRoot)).not.toContain('community-accounts.db')
      await chmod(userDataRoot, 0o500)
      try { expect((await fetch(`${communityEntryUrl(origin, admin)}fixture/home-note`, { headers: { cookie: admin }, redirect: 'manual' })).status).toBe(503) }
      finally { await chmod(userDataRoot, 0o700) }
      await application!.stop(); origin = await start(undefined, userDataRoot)
      for (const username of ['admin', 'member']) {
        const cookie = await signIn(origin, username, 'password', true)
        for (const location of ['home', 'workspace']) expect(await (await fetch(`${communityEntryUrl(origin, cookie)}fixture/${location}-note`, { headers: { cookie } })).text()).toBe(`${username}-${location}`)
      }
    } finally { await application?.stop(); await rm(userDataRoot, { recursive: true, force: true }) }
  })

  it('upgrades existing accounts while serving their original home and workspace directories', async () => {
    root = await mkdtemp(join(tmpdir(), 'community-old-layout-'))
    const previous = new DatabaseSync(join(root, 'community-accounts.db'))
    previous.exec(`CREATE TABLE accounts (
      username TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL,
      admin INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, session_epoch INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE TABLE bootstrap_state (id INTEGER PRIMARY KEY, completed INTEGER NOT NULL);
    INSERT INTO bootstrap_state VALUES (1, 1);
    CREATE TABLE retired_accounts (username TEXT PRIMARY KEY, retired_at INTEGER NOT NULL); PRAGMA user_version = 2;`)
    previous.prepare('INSERT INTO accounts VALUES (?, ?, ?, 1, 0, 0, 1, 1)').run('admin', 'admin@example.test', await hashPassword('password'))
    previous.close()
    for (const location of ['home', 'workspace']) {
      const directory = join(root, 'users', 'admin', location)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(join(directory, 'fixture-note.txt'), `original-${location}`)
    }
    const legacySettings = join(root, 'users/admin/home/.dsh/settings.yaml')
    await mkdir(join(root, 'users/admin/home/.dsh'), { recursive: true, mode: 0o700 })
    await writeFile(legacySettings, 'personal-fixture-settings: retained\n')
    let spaceId: string | undefined
    for (let restart = 0; restart < 2; restart++) {
      const origin = await start()
      expect(readBootstrapCredential(root)).toBeUndefined()
      const cookie = await signIn(origin, 'admin', 'password', true)
      for (const location of ['home', 'workspace']) {
        expect(await (await fetch(`${communityEntryUrl(origin, cookie)}fixture/${location}-note`, { headers: { cookie } })).text()).toBe(`original-${location}`)
      }
      const accounts = await (await fetch(`${origin}/admin/api/accounts`, { headers: { cookie } })).json() as { items: { spaceId: string }[] }
      expect(accounts.items[0]!.spaceId).toMatch(/^[a-f0-9]{32}$/u)
      spaceId ??= accounts.items[0]!.spaceId
      expect(accounts.items[0]!.spaceId).toBe(spaceId)
      const receipt = JSON.parse(await readFile(join(root, 'environment-upgrades', `${spaceId}.json`), 'utf8')) as { selectSharedModel: boolean, backup: { location: string } }
      expect(receipt.selectSharedModel).toBe(true)
      expect(await readFile(join(receipt.backup.location, 'files/.dsh/settings.yaml'), 'utf8')).toBe('personal-fixture-settings: retained\n')
      expect(await readdir(join(root, 'environment-backups', spaceId!))).toHaveLength(1)
      expect(await readFile(legacySettings, 'utf8')).toBe('personal-fixture-settings: retained\n')
      await application!.stop()
    }
  })

  it('refuses to adopt an old user volume when platform state at the same path was replaced', async () => {
    const userDataRoot = await mkdtemp(join(tmpdir(), 'community-retained-volume-'))
    try {
      const origin = await start(undefined, userDataRoot)
      const credential = readBootstrapCredential(root!)!.credential
      await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ credential, username: 'admin', email: 'admin@example.test', password: 'password' }) })
      const cookie = await signIn(origin, 'admin', 'password', true)
      expect((await fetch(`${communityEntryUrl(origin, cookie)}fixture/home-note`, { method: 'POST', headers: { cookie, origin }, body: 'original private file' })).status).toBe(200)
      await application!.stop()
      await rm(root!, { recursive: true, force: true })
      await expect(start(undefined, userDataRoot)).rejects.toThrow(/storage/iu)
      expect(await readFile(join(userDataRoot, 'admin', 'home', 'fixture-note.txt'), 'utf8')).toBe('original private file')
    } finally { await application?.stop(); await rm(userDataRoot, { recursive: true, force: true }) }
  })

  it('fails closed when configured user storage disappears instead of creating a blank replacement', async () => {
    const userDataRoot = await mkdtemp(join(tmpdir(), 'community-missing-disk-'))
    const detached = `${userDataRoot}-detached`
    try {
      await start(undefined, userDataRoot)
      await application!.stop()
      await rename(userDataRoot, detached)
      await expect(start(undefined, userDataRoot)).rejects.toThrow(/storage/iu)
      await expect(access(userDataRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await application?.stop(); await rm(userDataRoot, { recursive: true, force: true }); await rm(detached, { recursive: true, force: true }) }
  })

  it('rejects a user data root that would mount platform credentials inside a member home', async () => {
    const userDataRoot = await mkdtemp(join(tmpdir(), 'community-overlapping-storage-'))
    root = join(userDataRoot, 'member', 'home')
    try { await expect(start(undefined, userDataRoot)).rejects.toThrow(/storage/iu) }
    finally { await application?.stop(); await rm(userDataRoot, { recursive: true, force: true }) }
  })

  it('creates only the community account and required access/ownership persistence in a fresh data root', async () => {
    const origin = await start()
    expect((await fetch(`${origin}/healthz`)).status).toBe(200)
    await application!.stop()
    expect((await readdir(root!)).sort()).toEqual(['bootstrap-credential', 'community-accounts.db', 'managed-models', 'platform-lock.db', 'shared-models.json'])
  })

  it('releases startup ownership when configuration is rejected', async () => {
    await expect(start('short')).rejects.toThrow('session secret')
    expect((await fetch(`${await start()}/healthz`)).status).toBe(200)
  })

  it('keeps retired sessions separate when an administrator recreates the same username', async () => {
    let origin = await start()
    const credential = readBootstrapCredential(root!)!.credential
    const bootstrap = await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential, username: 'admin', email: 'admin@example.test', password: 'admin-password' }) })
    expect(bootstrap.status).toBe(303)
    const adminCookie = await signIn(origin, 'admin', 'admin-password')
    const action = (username: string, body: unknown, cookie = adminCookie, requestOrigin = origin) => fetch(`${origin}/admin/api/accounts/${username}/actions`, {
      method: 'POST', headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    for (const input of [{ action: 'set-disabled', disabled: true }, { action: 'set-admin', admin: false, groupId: 'default' }, { action: 'delete' }]) {
      expect((await action('admin', input)).status).toBe(409)
    }
    for (const username of ['member', 'other']) {
      const created = await fetch(`${origin}/admin/api/accounts`, { method: 'POST', headers: { cookie: adminCookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username, email: `${username}@example.test`, password: 'old-password' }) })
      expect(created.status).toBe(201)
    }
    const member = await signIn(origin, 'member', 'old-password')
    for (const note of ['home-note', 'workspace-note']) {
      expect((await fetch(`${communityEntryUrl(origin, member)}fixture/${note}`, { method: 'POST', headers: { cookie: member, origin }, body: 'retired account private file' })).status).toBe(200)
    }
    const device = await signIn(origin, 'member', 'old-password')
    const other = await signIn(origin, 'other', 'old-password')
    const entry = (cookie: string) => fetch(communityEntryUrl(origin, cookie), { headers: { cookie }, redirect: 'manual' })
    const memberRuntime = await (await entry(member)).text()
    const otherRuntime = await (await entry(other)).text()
    expect((await action('other', { action: 'delete' }, member)).status).toBe(403)
    expect((await action('member', { action: 'reset-password', password: 'new-password', admin: true })).status).toBe(400)
    expect((await action('member', { action: 'set-admin', admin: 'true' })).status).toBe(400)
    expect((await action('member', { action: 'delete' }, adminCookie, 'https://other.example.test')).status).toBe(403)
    const reset = await action('member', { action: 'reset-password', password: 'new-password' })
    expect(reset.status).toBe(200)
    expect(await reset.text()).not.toContain('new-password')
    for (const cookie of [member, device]) expect((await entry(cookie)).status).toBe(303)
    const refreshed = await signIn(origin, 'member', 'new-password')
    expect(await (await entry(refreshed)).text()).toBe(memberRuntime)
    expect((await action('member', { action: 'set-disabled', disabled: true })).status).toBe(200)
    expect((await entry(refreshed)).status).toBe(303)
    expect(await (await entry(other)).text()).toBe(otherRuntime)
    expect((await action('member', { action: 'set-disabled', disabled: false })).status).toBe(200)
    expect((await entry(refreshed)).status).toBe(303)
    const enabled = await signIn(origin, 'member', 'new-password')
    expect(await (await entry(enabled)).text()).not.toBe(memberRuntime)
    expect((await action('member', { action: 'set-admin', admin: true })).status).toBe(200)
    expect((await fetch(`${origin}/admin/api/session`, { headers: { cookie: enabled } })).status).toBe(200)
    expect((await action('member', { action: 'set-admin', admin: false, groupId: 'default' })).status).toBe(200)
    expect((await fetch(`${origin}/admin/api/session`, { headers: { cookie: enabled } })).status).toBe(403)
    const beforeDelete = await (await fetch(`${origin}/admin/api/accounts`, { headers: { cookie: adminCookie } })).json() as { items: { username: string, spaceId: string }[] }
    const oldSpace = beforeDelete.items.find(account => account.username === 'member')!.spaceId
    const deleted = await action('member', { action: 'delete' })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ kind: 'deleted', username: 'member', userSpace: 'preserved' })
    expect((await entry(enabled)).status).toBe(303)
    await application!.stop()
    origin = await start()
    const restartedAdmin = await signIn(origin, 'admin', 'admin-password')
    const reserved = await fetch(`${origin}/admin/api/accounts`, { method: 'POST', headers: { cookie: restartedAdmin, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member', email: 'replacement@example.test', password: 'password' }) })
    expect(reserved.status).toBe(201)
    const recreated = await reserved.json() as { spaceId: string }
    expect(recreated.spaceId).not.toBe(oldSpace)
    const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { cookie: member, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'member', password: 'password' }) })
    expect(login.status).toBe(303)
    expect(login.headers.get('clear-site-data')).toBe('"storage"')
    for (const cookie of [member, device, enabled]) expect((await entry(cookie)).status).toBe(303)
    const replacementCookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    expect((await entry(replacementCookie)).status).toBe(200)
    for (const note of ['home-note', 'workspace-note']) expect((await fetch(`${communityEntryUrl(origin, replacementCookie)}fixture/${note}`, { headers: { cookie: replacementCookie } })).status).toBe(404)
  })
  it('updates only a member email while preserving the space, login and private content', async () => {
    const origin = await start()
    await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(root!)!.credential, username: 'admin', password: 'password' }) })
    const admin = await signIn(origin, 'admin', 'password')
    for (const username of ['member', 'other']) {
      expect((await fetch(`${origin}/admin/api/accounts`, { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/json' }, body: JSON.stringify({ username, email: `${username}@example.test`, password: 'password' }) })).status).toBe(201)
    }
    const member = await signIn(origin, 'member', 'password')
    const note = `${communityEntryUrl(origin, member)}fixture/workspace-note`
    await fetch(note, { method: 'POST', headers: { cookie: member, origin }, body: 'email-update-retained' })
    const listing = async () => await (await fetch(`${origin}/admin/api/accounts`, { headers: { cookie: admin } })).json() as { items: { username: string, spaceId: string, email: string, admin: boolean, disabled: boolean }[] }
    const before = (await listing()).items.find(row => row.username === 'member')!
    const update = (email: string, cookie = admin, username = 'member') => fetch(`${origin}/admin/api/accounts/${username}/actions`, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'set-email', email }) })
    expect((await update('new@example.test')).status).toBe(200)
    expect((await listing()).items.find(row => row.username === 'member')).toMatchObject({ ...before, email: 'new@example.test' })
    expect(await (await fetch(note, { headers: { cookie: member } })).text()).toBe('email-update-retained')
    expect((await signIn(origin, 'member', 'password')).length).toBeGreaterThan(0)
    expect((await update('invalid')).status).toBe(400)
    expect((await update('OTHER@EXAMPLE.TEST')).status).toBe(409)
    expect((await update('another@example.test', member)).status).toBe(403)
    expect((await update('another@example.test', '')).status).toBe(401)
    expect((await update('another@example.test', admin, 'missing')).status).toBe(404)
    expect((await update('retry@example.test')).status).toBe(200)
    expect((await listing()).items.find(row => row.username === 'member')?.email).toBe('retry@example.test')
  })

})
