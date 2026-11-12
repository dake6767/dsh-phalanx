import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'
let app: CommunityApplication | undefined, root: string | undefined

afterEach(async () => {
  await app?.stop()
  if (root) await removeCommunityFixture(root)
})
it('returns the authenticated display identity and current administrator role without requiring a DSH instance', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-identity-'))
  app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'identity-fixture-session-secret-at-least-32-bytes',
    runtime: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const origin = await app.start()
  const call = async (cookie?: string, method = 'GET') =>
    await fetch(`${origin}/account/identity?username=admin`, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), origin } })
  const features = (cookie?: string, method = 'GET') =>
    fetch(`${origin}/account/platform-features?groupId=admin`, { method, redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), origin } })
  const absent = await call()
  expect(absent.status).toBe(401)
  expect(await absent.json()).toEqual({ error: 'Sign in is required', code: 'sign-in-required' })
  expect((await features()).status).toBe(401)
  const bootstrap = await fetch(`${origin}/bootstrap`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }),
  })
  const admin = bootstrap.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ')
  expect(await (await call(admin)).json()).toEqual({ username: 'admin', admin: true })
  expect(await (await features(admin)).json()).toEqual({ showAppCenter: false })
  const adminFeatures = origin + '/admin/api/groups/admin/native-features'
  const revision = (await (await fetch(adminFeatures, { headers: { cookie: admin } })).json()).revision
  expect(
    (
      await fetch(adminFeatures, {
        method: 'POST',
        headers: { cookie: admin, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ revision, disabledIds: [], showAppCenter: true }),
      })
    ).status,
  ).toBe(200)
  expect(
    (
      await fetch(`${origin}/admin/api/accounts`, {
        method: 'POST',
        headers: { cookie: admin, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'member', email: 'member@example.test', password: 'password' }),
      })
    ).status,
  ).toBe(201)
  const login = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'member', password: 'password' }),
  })
  const member = login.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ')
  expect(await (await call(member)).json()).toEqual({ username: 'member', admin: false })
  expect(await (await features(member)).json()).toEqual({ showAppCenter: false })
  const records = await (await fetch(`${origin}/admin/api/accounts`, { headers: { cookie: admin } })).json()
  const groupId = records.items.find((row: { username: string }) => row.username === 'member').groupId
  const role = (value: object) =>
    fetch(`${origin}/admin/api/accounts/member/actions`, {
      method: 'POST',
      headers: { cookie: admin, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'set-admin', ...value }),
    })
  expect((await role({ admin: true })).status).toBe(200)
  expect(await (await call(member)).json()).toEqual({ username: 'member', admin: true })
  expect(await (await features(member)).json()).toEqual({ showAppCenter: true })
  expect((await role({ admin: false, groupId })).status).toBe(200)
  expect(await (await call(member)).json()).toEqual({ username: 'member', admin: false })
  expect((await call(member)).headers.get('cache-control')).toBe('no-store')
  expect((await call(member, 'POST')).status).toBe(405)
  expect(await (await features(member)).json()).toEqual({ showAppCenter: false })
  expect((await features(member, 'POST')).status).toBe(405)
  expect((await fetch(`${origin}/admin/api/session`, { headers: { cookie: member } })).status).toBe(403)
  expect(
    (
      await fetch(`${origin}/admin/api/accounts/member/actions`, {
        method: 'POST',
        headers: { cookie: admin, origin, 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'set-disabled', disabled: true }),
      })
    ).status,
  ).toBe(200)
  expect((await call(member)).status).toBe(401)
  expect((await features(member)).status).toBe(401)
})
