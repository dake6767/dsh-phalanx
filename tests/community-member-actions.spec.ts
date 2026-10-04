import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'

let app: CommunityApplication | undefined; let root: string | undefined
afterEach(async () => { await app?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
it('offers recovery without DSH, restarts only the session owner, refreshes runtime cookies and logs out without stopping work', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-member-action-'))
  app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'community-action-fixture-secret-32-bytes', runtime: {
    command: process.execPath, args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))], dataRoot: root,
    defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } } } })
  const origin = await app.start()
  const headers = { origin, 'content-type': 'application/x-www-form-urlencoded' }
  const bootstrap = await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual', headers,
    body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
  const adminCookie = bootstrap.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
  expect((await fetch(`${origin}/admin/api/accounts`, { method: 'POST', headers: { origin, cookie: adminCookie, 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'alice', email: 'alice@example.test', password: 'password' }) })).status).toBe(201)
  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers, body: new URLSearchParams({ username: 'alice', password: 'password' }) })
  const cookie = login.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
  const recovery = await fetch(`${origin}/recovery`, { headers: { cookie } }); expect(recovery.status).toBe(200)
  expect(await recovery.text()).toContain('Restart instance')
  const actionHeaders = { origin, cookie, 'content-type': 'application/json' }
  const rejected = await fetch(`${origin}/recovery/restart`, { method: 'POST', headers: actionHeaders, body: JSON.stringify({ confirmed: true, username: 'bob' }) })
  expect(rejected.status).toBe(400)
  expect((await fetch(`${origin}/recovery/restart`, { method: 'POST', headers: { ...actionHeaders, origin: 'https://cross.example' }, body: JSON.stringify({ confirmed: true }) })).status).toBe(403)
  expect((await fetch(`${origin}/recovery/restart`, { method: 'POST', headers: actionHeaders, body: JSON.stringify({ confirmed: false }) })).status).toBe(400)
  const restart = await fetch(`${origin}/recovery/restart`, { method: 'POST', headers: actionHeaders, body: JSON.stringify({ confirmed: true }) })
  expect(restart.status).toBe(200)
  const body = await restart.json() as { entry: string }
  expect(body.entry).toMatch(/^\/app\/[^/]+\/$/u)
  expect(restart.headers.getSetCookie().length).toBeGreaterThan(0)
  const logout = await fetch(`${origin}/logout`, { method: 'POST', headers: { origin, cookie }, redirect: 'manual' })
  expect(logout.status).toBe(303); expect(logout.headers.get('location')).toBe('/login'); expect(logout.headers.getSetCookie()[0]).toContain('Max-Age=0')
  expect((await fetch(`${origin}${body.entry}`, { redirect: 'manual' })).headers.get('location')).toBe('/login')
  expect((await fetch(`${origin}/recovery`, { redirect: 'manual' })).headers.get('location')).toBe('/login')
})
