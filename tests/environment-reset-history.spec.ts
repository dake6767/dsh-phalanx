import { mkdtemp, readFile, rm, lstat, mkdir, readdir, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FileEnvironmentResetHistory } from '../src/adapters/environment-reset-history.js'

let root: string | undefined
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }) })
it('retains the member cooldown and latest initiator across reopen in a private file', async () => {
  root = await mkdtemp(join(tmpdir(), 'reset-history-')); const path = join(root, 'history.json'), space = 'a'.repeat(32)
  const first = new FileEnvironmentResetHistory(path)
  first.save(space, { lastMemberAcceptedAt: 0, recent: { at: 0, username: 'alice', role: 'member' } })
  const reopened = new FileEnvironmentResetHistory(path)
  expect(reopened.get(space)).toEqual({ lastMemberAcceptedAt: 0, recent: { at: 0, username: 'alice', role: 'member' } })
  reopened.save(space, { ...reopened.get(space)!, recent: { at: 100, username: 'admin', role: 'admin' } })
  expect(new FileEnvironmentResetHistory(path).get(space)).toEqual({ lastMemberAcceptedAt: 0, recent: { at: 100, username: 'admin', role: 'admin' } })
  expect((await lstat(path)).mode & 0o077).toBe(0)
  expect(Object.isFrozen(reopened.get(space))).toBe(true); expect(Object.isFrozen(reopened.get(space)!.recent)).toBe(true)
  const bytes = await readFile(path, 'utf8'); await rm(path); await mkdir(path)
  expect(() => reopened.save(space, { recent: { at: 200, username: 'admin', role: 'admin' } })).toThrow()
  expect(reopened.get(space)!.recent.at).toBe(100)
  expect((await readdir(root)).filter(name => name.includes('.tmp-'))).toEqual([])
  await rm(path, { recursive: true }); await writeFile(path, bytes, { mode: 0o600 })
  expect(new FileEnvironmentResetHistory(path).get(space)!.recent.at).toBe(100)
})

it('rejects linked, public or malformed history rather than silently resetting the member window', async () => {
  root = await mkdtemp(join(tmpdir(), 'reset-history-invalid-')); const path = join(root, 'history.json'), other = join(root, 'other.json')
  await writeFile(other, '{"version":1,"spaces":{}}', { mode: 0o600 }); await symlink(other, path)
  expect(() => new FileEnvironmentResetHistory(path)).toThrow(); expect(await readFile(other, 'utf8')).toBe('{"version":1,"spaces":{}}')
  await rm(path); await writeFile(path, '{"version":1,"spaces":{}}', { mode: 0o644 })
  expect(() => new FileEnvironmentResetHistory(path)).toThrow()
  await rm(path); await writeFile(path, JSON.stringify({ version: 1, spaces: { ['a'.repeat(32)]: { lastMemberAcceptedAt: -1, recent: { at: 0, username: 'alice', role: 'member' } } } }), { mode: 0o600 })
  expect(() => new FileEnvironmentResetHistory(path)).toThrow()
})

it('releases platform startup ownership when private history cannot load', async () => {
  const { createCommunityApplication } = await import('../src/composition/community-application.js')
  root = await mkdtemp(join(tmpdir(), 'reset-history-startup-'))
  const path = join(root, 'environment-reset-history.json')
  await writeFile(path, '{broken', { mode: 0o600 })
  const config = { listen: { host: '127.0.0.1', port: 0 }, sessionSecret: 'history-startup-fixture-secret-at-least-32-bytes', runtime: { command: '/unavailable-dsh', args: [], dataRoot: root, defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'http://127.0.0.1:1' } } } }
  expect(() => createCommunityApplication(config)).toThrow()
  await rm(path)
  const app = createCommunityApplication(config)
  try { expect(await app.start()).toMatch(/^http:/u) } finally { await app.stop() }
})
