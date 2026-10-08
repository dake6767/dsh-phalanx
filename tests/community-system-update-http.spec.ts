import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunitySystemUpdatePort } from '../src/ports/community-system-update.js'
import type { CommunitySystemUpdateOperation } from '../src/domain/admin-contract.js'

let application: CommunityApplication | undefined
let root: string | undefined
afterEach(async () => { await application?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
it('admits only fresh administrators and same-origin closed update requests through the public entry', async () => {
  const operation: CommunitySystemUpdateOperation = { id: '12345678-1234-1234-1234-123456789abc', phase: 'prepared', targetVersion: 'v0.1.3', sourceVersion: 'v0.1.2', targetCommit: 'b'.repeat(40), platformSha256: 'a'.repeat(64), imageDigest: `sha256:${'c'.repeat(64)}` }
  const calls: string[] = []
  const updates: CommunitySystemUpdatePort = {
    status: async id => { calls.push(`status:${id ?? ''}`); return { currentVersion: 'v0.1.2', runningVersion: 'v0.1.2', operation, events: [] } },
    check: async () => { calls.push('check'); return { currentVersion: 'v0.1.2', runningVersion: 'v0.1.2', operation, events: [], check: { status: 'failed', checkedAt: '2026-10-05T00:00:00Z', reason: 'Release source unavailable' } } },
    prepare: async () => { calls.push('prepare'); return { operation } }, apply: async id => { calls.push(`apply:${id}`); return { operation: { ...operation, phase: 'stopping' } } },
  }
  root = await mkdtemp(join(tmpdir(), 'community-update-http-'))
  application = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'community-update-fixture-secret-32-bytes', runtime: {
    command: process.execPath, args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))], dataRoot: root,
    defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } },
  } }, { systemUpdate: updates })
  const origin = await application.start()
  const bootstrap = await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
  const admin = bootstrap.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const create = await fetch(`${origin}/admin/api/accounts`, { method: 'POST', headers: { cookie: admin, origin, 'content-type': 'application/json' }, body: JSON.stringify({ username: 'member', email: 'member@example.test', password: 'password' }) })
  expect(create.status).toBe(201)
  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ username: 'member', email: 'member@example.test', password: 'password' }) })
  const member = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  const get = (cookie = admin, suffix = '') => fetch(`${origin}/admin/api/system-update${suffix}`, { headers: { cookie } })
  const post = (body: unknown, cookie = admin, requestOrigin = origin) => fetch(`${origin}/admin/api/system-update`, { method: 'POST', headers: { cookie, origin: requestOrigin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const unauthenticated = await get('')
  expect(unauthenticated.status).toBe(401)
  expect(await unauthenticated.json()).toEqual({ error: 'Sign in is required', code: 'sign-in-required' })
  const forbidden = await get(member)
  expect(forbidden.status).toBe(403)
  expect(await forbidden.json()).toEqual({ error: 'Administrator access is required', code: 'admin-required' })
  expect((await post({ action: 'check' }, member)).status).toBe(403)
  expect((await post({ action: 'check' }, admin, 'https://other.example.test')).status).toBe(403)
  for (const input of [{ action: 'check', url: 'https://evil.example.test' }, { action: 'recover' }, { action: 'apply', operation: operation.id, confirmed: false }, { action: 'prepare', version: 'v0.1.3-rc.1', manifestSha256: 'a'.repeat(64) }]) expect((await post(input)).status).toBe(400)
  expect((await get(admin, '?operation=/etc/passwd')).status).toBe(400)
  expect(calls).toEqual([])
  expect(await (await post({ action: 'check' })).json()).toMatchObject({ check: { status: 'failed' } })
  expect(await (await get(admin, `?operation=${operation.id}`)).json()).toMatchObject({ operation: { id: operation.id, phase: 'prepared' } })
  expect((await post({ action: 'prepare', version: 'v0.1.3', manifestSha256: 'a'.repeat(64) })).status).toBe(200)
  expect(await (await post({ action: 'apply', operation: operation.id, confirmed: true })).json()).toMatchObject({ operation: { phase: 'stopping' } })
  expect(calls).toEqual(['check', `status:${operation.id}`, 'prepare', `apply:${operation.id}`])
})
