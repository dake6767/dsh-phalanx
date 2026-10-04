import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'

let app: CommunityApplication | undefined
let root: string | undefined
afterEach(async () => { await app?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
it('uses durable space URLs, strips the authenticated mount and refuses crossed HTTP and WebSocket entry', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-mount-'))
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'community-mount-fixture-secret-32-bytes',
    runtime: { command: process.execPath, args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))], dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } } } }
  app = createCommunityApplication(config); let origin = await app.start()
  const cookieOf = (response: Response) => response.headers.getSetCookie().map(cookie => cookie.split(';')[0]).join('; ')
  const bootstrap = await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
  const adminCookie = cookieOf(bootstrap)
  const members = []
  for (const username of ['alice', 'bob']) {
    const created = await fetch(`${origin}/admin/api/accounts`, { method: 'POST', headers: { cookie: adminCookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ username, email: `${username}@example.test`, password: 'password' }) })
    expect(created.status).toBe(201)
    const account = await created.json() as { spaceId: string }
    const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password: 'password' }) })
    expect(login.headers.get('location')).toBe(`/app/${account.spaceId}/`)
    const cookie = cookieOf(login)
    const runtimeCookies = login.headers.getSetCookie().filter(value => !value.startsWith('dsh-phalanx_'))
    expect(runtimeCookies.length).toBeGreaterThan(0)
    expect(runtimeCookies.every(value => value.includes(`Path=/app/${account.spaceId}/`))).toBe(true)
    members.push({ username, spaceId: account.spaceId, cookie })
  }
  const alice = members[0]!; const bob = members[1]!
  const path = `/app/${alice.spaceId}/`
  const updatedCookie = await fetch(`${origin}${path}fixture/session-cookie`, { headers: { cookie: alice.cookie } })
  expect(updatedCookie.headers.getSetCookie()).toEqual([`dsh_fixture_extra=scope; Path=${path}; HttpOnly; SameSite=Strict`])
  for (const [target, status] of [[path, 200], [`/app/${bob.spaceId}/`, 403], ['/app/unknown/', 403]] as const) {
    expect((await fetch(`${origin}${target}`, { headers: { cookie: alice.cookie }, redirect: 'manual' })).status).toBe(status)
  }
  for (const target of ['/', path.slice(0, -1)]) {
    const response = await fetch(`${origin}${target}`, { headers: { cookie: alice.cookie }, redirect: 'manual' })
    expect(response.status).toBe(303); expect(response.headers.get('location')).toBe(path)
  }
  const crossed = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace(/^http/u, 'ws')}/app/${bob.spaceId}/api/remote.mux`, { headers: { cookie: alice.cookie } })
    socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!) })
    socket.once('open', () => { socket.close(); reject(new Error('Crossed WebSocket was admitted')) }); socket.once('error', reject)
  })
  expect(crossed).toBe(403)
  await app.stop(); app = createCommunityApplication(config); origin = await app.start()
  expect((await fetch(`${origin}${path}`, { headers: { cookie: alice.cookie }, redirect: 'manual' })).status).toBe(200)
  const adminEntry = await fetch(`${origin}/enter`, { headers: { cookie: adminCookie }, redirect: 'manual' })
  expect(adminEntry.status).toBe(303); expect(adminEntry.headers.get('location')).toMatch(/^\/app\/[^/]+\/$/u)
  const deleted = await fetch(`${origin}/admin/api/accounts/bob/actions`, { method: 'POST', headers: { cookie: adminCookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'delete' }) })
  expect(deleted.status).toBe(200)
  expect((await fetch(`${origin}/app/${bob.spaceId}/`, { headers: { cookie: bob.cookie }, redirect: 'manual' })).headers.get('location')).toBe('/login')
  const replacement = await fetch(`${origin}/admin/api/accounts`, { method: 'POST', headers: { cookie: adminCookie, origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'bob', email: 'replacement@example.test', password: 'password' }) })
  expect(replacement.status).toBe(201)
  expect((await replacement.json() as { spaceId: string }).spaceId).not.toBe(bob.spaceId)
  const fresh = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { origin, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'bob', password: 'password' }) })
  expect((await fetch(`${origin}/app/${bob.spaceId}/`, { headers: { cookie: cookieOf(fresh) }, redirect: 'manual' })).status).toBe(403)
})
