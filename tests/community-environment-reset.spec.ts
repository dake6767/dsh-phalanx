import { openCommunityHttpEntry } from './support/community-http-entry.js'
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, readdir, symlink, readlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createCommunityApplication } from '../src/composition/community-application.js'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import type { CommunityApplication } from '../src/ports/community-application.js'
import type { CommunityEnvironmentResetResult } from '../src/domain/admin-contract.js'

let app: CommunityApplication | undefined; let root: string | undefined
afterEach(async () => { await app?.stop(); if (root) await rm(root, { recursive: true, force: true }) })
it('allows only confirmed same-origin administrator repair, privately backs up the broken environment and preserves stable member data', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-environment-'))
  app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'community-environment-fixture-32-bytes', runtime: {
    command: process.execPath, args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))], dataRoot: root,
    defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } } } })
  const origin = await app.start()
  const form = { origin, 'content-type': 'application/x-www-form-urlencoded' }
  const bootstrap = await fetch(`${origin}/bootstrap`, { method: 'POST', redirect: 'manual', headers: form,
    body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
  const adminCookie = bootstrap.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
  const headers = { origin, cookie: adminCookie, 'content-type': 'application/json' }
  expect((await fetch(`${origin}/admin/api/accounts`, { method: 'POST', headers,
    body: JSON.stringify({ username: 'alice', email: '', password: 'password' }) })).status).toBe(201)
  const login = await fetch(`${origin}/login`, { method: 'POST', redirect: 'manual', headers: form, body: new URLSearchParams({ username: 'alice', password: 'password' }) })
  const cookie = (await openCommunityHttpEntry(origin, login.headers.getSetCookie().map(row => row.split(';')[0]).join('; '))).cookie
  const entry = login.headers.get('location')!
  const home = join(root, 'users/alice/home'); const patch = join(home, '.dsh/profiles/web/cordis.patch.yml')
  await mkdir(join(home, '.dsh/retained-records'), { recursive: true })
  await writeFile(join(home, 'personal.txt'), 'KEEP_HOME'); await writeFile(join(root, 'users/alice/workspace/project.txt'), 'KEEP_PROJECT')
  await writeFile(join(home, '.dsh/retained-records/chat.txt'), 'KEEP_RECORD')
  await writeFile(patch, 'BROKEN_CONFIG_FIXTURE\n')
  const endpoint = `${origin}/admin/api/accounts/alice/reset-environment`
  const post = (body: unknown, custom = headers) => fetch(endpoint, { method: 'POST', headers: custom, body: JSON.stringify(body) })
  expect((await post({ confirmed: true }, { ...headers, cookie })).status).toBe(403)
  expect((await post({ confirmed: true }, { ...headers, origin: 'https://cross.example' })).status).toBe(403)
  expect((await post({ confirmed: false })).status).toBe(400)
  expect((await post({ confirmed: true, username: 'bob' })).status).toBe(400)
  const reset = await post({ confirmed: true }); expect(reset.status).toBe(200)
  const result = await reset.json() as CommunityEnvironmentResetResult
  expect(result.entry).toBe(entry); expect(result.username).toBe('alice'); expect(result.backup.location.startsWith(join(root, 'environment-backups'))).toBe(true)
  expect((await lstat(join(root, 'environment-backups'))).mode & 0o077).toBe(0)
  expect(await readFile(join(result.backup.location, 'files/.dsh/profiles/web/cordis.patch.yml'), 'utf8')).toBe('BROKEN_CONFIG_FIXTURE\n')
  expect(await readFile(join(result.backup.location, 'README.txt'), 'utf8')).toContain('target container')
  expect(await readFile(join(home, 'personal.txt'), 'utf8')).toBe('KEEP_HOME')
  expect(await readFile(join(root, 'users/alice/workspace/project.txt'), 'utf8')).toBe('KEEP_PROJECT')
  expect(await readFile(join(home, '.dsh/retained-records/chat.txt'), 'utf8')).toBe('KEEP_RECORD')
  expect(await readFile(patch, 'utf8')).not.toContain('BROKEN_CONFIG_FIXTURE')
  const retry = await post({ confirmed: true }); expect(retry.status).toBe(200)
  expect((await readdir(join(root, 'environment-backups', result.spaceId))).length).toBe(2)
  const other = join(root, 'other-private.txt'); await writeFile(other, 'OTHER_PRIVATE_CONFIG')
  await rm(patch); await symlink(other, patch)
  const linked = await post({ confirmed: true }); expect(linked.status).toBe(200)
  const linkedBackup = (await linked.json() as CommunityEnvironmentResetResult).backup
  expect(await readlink(join(linkedBackup.location, 'files/.dsh/profiles/web/cordis.patch.yml'))).toBe(other)
  expect(await readFile(other, 'utf8')).toBe('OTHER_PRIVATE_CONFIG')
  expect(await readFile(patch, 'utf8')).not.toContain('OTHER_PRIVATE_CONFIG')
  // A special configuration file cannot be copied; resetting must not proceed.
  await writeFile(patch, 'KEEP_BROKEN_CONFIG_ON_BACKUP_FAILURE')
  await promisify(execFile)('mkfifo', [join(home, '.dsh/profiles/web/fixture-pipe')])
  const failed = await post({ confirmed: true }); expect(failed.status).toBe(503)
  expect(await failed.json()).toMatchObject({ phase: 'backup' })
  expect(await readFile(patch, 'utf8')).toBe('KEEP_BROKEN_CONFIG_ON_BACKUP_FAILURE')
  expect(await readFile(join(home, 'personal.txt'), 'utf8')).toBe('KEEP_HOME')
})

it('admits only confirmed same-origin self reset, hides backup paths and keeps the cooldown after platform reopen', async () => {
  root = await mkdtemp(join(tmpdir(), 'community-self-environment-')); let now = 10000
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'community-self-environment-fixture-32-bytes', runtime: {
    command: process.execPath, args: [fileURLToPath(new URL('./fixtures/runtime.mjs', import.meta.url))], dataRoot: root,
    defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } } } }
  const start = async () => { app = createCommunityApplication(config, { clock: { now: () => now } }); return await app.start() }
  let origin = await start()
  const form = () => ({ origin, 'content-type': 'application/x-www-form-urlencoded' })
  const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: form(), body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
  const adminCookie = bootstrap.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
  const adminHeaders = () => ({ origin, cookie: adminCookie, 'content-type': 'application/json' })
  expect((await fetch(origin + '/admin/api/accounts', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ username: 'alice', email: '', password: 'password' }) })).status).toBe(201)
  const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: form(), body: new URLSearchParams({ username: 'alice', password: 'password' }) })
  const cookie = (await openCommunityHttpEntry(origin, login.headers.getSetCookie().map(row => row.split(';')[0]).join('; '))).cookie
  const headers = () => ({ origin, cookie, 'content-type': 'application/json' })
  const post = (data: unknown, custom = headers()) => fetch(origin + '/recovery/reset', { method: 'POST', headers: custom, body: JSON.stringify(data) })
  expect((await post({ confirmed: true }, { ...headers(), origin: 'https://cross.example' })).status).toBe(403)
  expect((await post({ confirmed: false })).status).toBe(400)
  expect((await post({ confirmed: true, username: 'admin' })).status).toBe(400)
  const response = await post({ confirmed: true }); expect(response.status).toBe(200)
  const body = await response.text(); expect(JSON.parse(body)).toEqual({ entry: login.headers.get('location') })
  expect(body).not.toContain(root); expect(body).not.toContain('backup')
  const accounts = await (await fetch(origin + '/admin/api/accounts', { headers: adminHeaders() })).json()
  expect(accounts.items.find((row: { username: string }) => row.username === 'alice').lastEnvironmentReset).toEqual({ at: 10000, username: 'alice', role: 'member' })
  expect((await post({ confirmed: true })).status).toBe(409)
  expect((await fetch(origin + '/admin/api/accounts/alice/reset-environment', { method: 'POST', headers: adminHeaders(), body: JSON.stringify({ confirmed: true }) })).status).toBe(200)
  await app!.stop(); now = 609999; origin = await start()
  const limited = await post({ confirmed: true }); expect(limited.status).toBe(409)
  expect(await limited.json()).toMatchObject({ code: 'environment-reset-rate-limited', params: { seconds: 1 } })
  now = 610000; expect((await post({ confirmed: true })).status).toBe(200)
})

it.each(['stop', 'backup', 'reset', 'start'] as const)('keeps %s failures private on the self route while preserving the administrator failure DTO', async phase => {
  root = await mkdtemp(join(tmpdir(), 'community-self-failure-'))
  const backup = { id: 'fixture-backup', location: join(root, 'private-backup'), restoreInstructionsPath: join(root, 'private-backup/README.txt'), restoreInstructions: `Follow ${join(root, 'private-backup/README.txt')}` }
  const instance = (userId: string) => ({ userId, processId: 1, origin: 'http://localhost', launchUrl: 'http://localhost' })
  app = createCommunityApplication({ listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'self-failure-fixture-secret-at-least-32-bytes', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } } } }, {
    runtime: { reconcileStartupContainers: async () => ({ adopted: [], swept: [] }), ensure: async user => instance(user), restart: async user => instance(user), terminate: async () => {}, status: () => ({ state: 'stopped' }), reclaim: async () => 'not-running', stopAll: async () => {},
      recover: async (user, _origin, prepare) => { if (phase === 'stop') throw Error(backup.location); await prepare(); if (phase === 'start') throw Error(backup.location); return instance(user) } },
    environment: { backup: async () => { if (phase === 'backup') throw Error(backup.location); return backup }, reset: async () => { if (phase === 'reset') throw Error(backup.location) } },
  })
  const origin = await app.start(), form = { origin, 'content-type': 'application/x-www-form-urlencoded' }
  const bootstrap = await fetch(origin + '/bootstrap', { method: 'POST', redirect: 'manual', headers: form, body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }) })
  const adminCookie = bootstrap.headers.getSetCookie().map(row => row.split(';')[0]).join('; '), headers = { origin, cookie: adminCookie, 'content-type': 'application/json' }
  expect((await fetch(origin + '/admin/api/accounts', { method: 'POST', headers, body: JSON.stringify({ username: 'alice', email: '', password: 'password' }) })).status).toBe(201)
  const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual', headers: form, body: new URLSearchParams({ username: 'alice', password: 'password' }) })
  const cookie = login.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
  const member = await fetch(origin + '/recovery/reset', { method: 'POST', headers: { ...headers, cookie }, body: JSON.stringify({ confirmed: true }) })
  expect(member.status).toBe(503)
  const text = await member.text(); expect(JSON.parse(text)).toMatchObject({ code: 'environment-self-reset-failed', phase })
  expect(text).not.toContain(root); expect(JSON.parse(text)).not.toHaveProperty('backup'); expect(text).not.toContain('restoreInstructions')
  const admin = await fetch(origin + '/admin/api/accounts/alice/reset-environment', { method: 'POST', headers, body: JSON.stringify({ confirmed: true }) })
  expect(admin.status).toBe(503)
  const failure = await admin.json()
  expect(failure).toMatchObject({ code: 'environment-recovery-failed', phase })
  if (phase === 'reset' || phase === 'start') expect(failure.backup).toEqual(backup)
})
