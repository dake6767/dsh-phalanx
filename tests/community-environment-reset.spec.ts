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
  const cookie = login.headers.getSetCookie().map(row => row.split(';')[0]).join('; ')
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
