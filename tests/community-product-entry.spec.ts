import { mkdtemp, readdir, rm } from 'node:fs/promises'
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
  const start = async (sessionSecret = 'community-fixture-session-secret-with-32-bytes'): Promise<string> => {
    root ??= await mkdtemp(join(tmpdir(), 'community-entry-'))
    application = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret,
      runtime: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))], dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } } } })
    return await application.start()
  }
  const signIn = async (origin: string, username: string, password: string): Promise<string> => {
    const response = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username, password }) })
    expect(response.status).toBe(303)
    return response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  }
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
    for (const path of ['/admin/groups', '/admin/presets', '/admin/plugins', '/admin/external', '/admin/records',
      '/admin/api/groups', '/admin/api/keys', '/admin/api/credentials', '/admin/api/records',
      '/account/records', '/account/connect/test', '/_dsh-phalanx/service/test', '/_dsh-phalanx/plugin/test']) {
      expect((await fetch(`${origin}${path}`, { headers: { cookie: adminCookie }, redirect: 'manual' })).status, path).toBe(404)
    }
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
    expect(await created.json()).toMatchObject({ username: 'member', admin: false })
    const memberCookie = await signIn(origin, 'member', 'member-password')
    expect((await fetch(`${origin}/`, { headers: { cookie: memberCookie } })).status).toBe(200)
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
    const restartedCookie = await signIn(origin, 'member', 'member-password')
    expect((await fetch(`${origin}/`, { headers: { cookie: restartedCookie } })).status).toBe(200)
    await application!.stop()
    expect((await readdir(root!)).sort()).toEqual(['community-accounts.db', 'model-access.json', 'platform-lock.db', 'users'])
  })

  it('creates only the community account and required access/ownership persistence in a fresh data root', async () => {
    const origin = await start()
    expect((await fetch(`${origin}/healthz`)).status).toBe(200)
    await application!.stop()
    expect((await readdir(root!)).sort()).toEqual(['bootstrap-credential', 'community-accounts.db', 'platform-lock.db'])
  })

  it('releases startup ownership when configuration is rejected', async () => {
    await expect(start('short')).rejects.toThrow('session secret')
    expect((await fetch(`${await start()}/healthz`)).status).toBe(200)
  })

  it('manages passwords, access and roles through the public API while reserving deleted identities', async () => {
    let origin = await start()
    const credential = readBootstrapCredential(root!)!.credential
    const bootstrap = await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential, username: 'admin', email: 'admin@example.test', password: 'admin-password' }) })
    expect(bootstrap.status).toBe(303)
    const adminCookie = await signIn(origin, 'admin', 'admin-password')
    const action = (username: string, body: unknown, cookie = adminCookie, requestOrigin = origin) => fetch(`${origin}/admin/api/accounts/${username}/actions`, {
      method: 'POST', headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body),
    })
    for (const input of [{ action: 'set-disabled', disabled: true }, { action: 'set-admin', admin: false }, { action: 'delete' }]) {
      expect((await action('admin', input)).status).toBe(409)
    }
    for (const username of ['member', 'other']) {
      const created = await fetch(`${origin}/admin/api/accounts`, { method: 'POST', headers: { cookie: adminCookie, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username, email: `${username}@example.test`, password: 'old-password' }) })
      expect(created.status).toBe(201)
    }
    const member = await signIn(origin, 'member', 'old-password')
    const device = await signIn(origin, 'member', 'old-password')
    const other = await signIn(origin, 'other', 'old-password')
    const entry = (cookie: string) => fetch(`${origin}/`, { headers: { cookie }, redirect: 'manual' })
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
    expect((await action('member', { action: 'set-admin', admin: false })).status).toBe(200)
    expect((await fetch(`${origin}/admin/api/session`, { headers: { cookie: enabled } })).status).toBe(403)
    const deleted = await action('member', { action: 'delete' })
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toEqual({ kind: 'deleted', username: 'member', userSpace: 'preserved' })
    expect((await entry(enabled)).status).toBe(303)
    await application!.stop()
    origin = await start()
    const restartedAdmin = await signIn(origin, 'admin', 'admin-password')
    const reserved = await fetch(`${origin}/admin/api/accounts`, { method: 'POST', headers: { cookie: restartedAdmin, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'member', email: 'replacement@example.test', password: 'password' }) })
    expect(reserved.status).toBe(409)
    expect(await reserved.text()).toContain('reserved')
  })
})
