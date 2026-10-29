import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'

let application: CommunityApplication | undefined
let root: string | undefined
afterEach(async () => {
  await application?.stop()
  if (root) await removeCommunityFixture(root)
})
it('shares current-key backup status through authenticated same-origin administration requests', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-update-http-'))
  application = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'community-update-fixture-secret-32-bytes',
    runtime: {
      command: process.execPath,
      args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
    },
  })
  const origin = await application.start()
  const bootstrap = await fetch(`${origin}/bootstrap`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }),
  })
  const admin = bootstrap.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ')
  const create = await fetch(`${origin}/admin/api/accounts`, {
    method: 'POST',
    headers: { cookie: admin, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'member', email: 'member@example.test', password: 'password' }),
  })
  expect(create.status).toBe(201)
  const login = await fetch(`${origin}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'member', email: 'member@example.test', password: 'password' }),
  })
  const member = login.headers
    .getSetCookie()
    .map(value => value.split(';')[0])
    .join('; ')
  const get = (cookie = admin) => fetch(`${origin}/admin/api/system-status`, { headers: { cookie } })
  const post = (body: unknown, cookie = admin, requestOrigin = origin) =>
    fetch(`${origin}/admin/api/system-status`, {
      method: 'POST',
      headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  expect((await get('')).status).toBe(401)
  expect((await get(member)).status).toBe(403)
  const response = await get()
  expect(response.status).toBe(200)
  const initial = (await response.json()) as { masterKey: { fingerprint: string; backup: unknown } }
  expect(initial.masterKey.backup).toBeNull()
  const action = { action: 'confirm-backup', fingerprint: initial.masterKey.fingerprint }
  expect((await post(action, member)).status).toBe(403)
  expect((await post(action, admin, 'https://other.example.test')).status).toBe(403)
  expect((await post({ ...action, export: true })).status).toBe(400)
  expect((await post({ action: 'export-key' })).status).toBe(400)
  expect((await post({ ...action, fingerprint: `sha256:${'f'.repeat(64)}` })).status).toBe(409)
  expect((await post(action)).status).toBe(200)
  const promoted = await fetch(`${origin}/admin/api/accounts/member/actions`, {
    method: 'POST',
    headers: { cookie: admin, origin, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'set-admin', admin: true }),
  })
  expect(promoted.status).toBe(200)
  expect(await (await get(member)).json()).toMatchObject({
    masterKey: { fingerprint: initial.masterKey.fingerprint, backup: { username: 'admin', confirmedAt: expect.any(String) } },
  })
  expect(await (await get()).json()).toMatchObject({
    masterKey: { fingerprint: initial.masterKey.fingerprint, backup: { username: 'admin', confirmedAt: expect.any(String) } },
  })
})
