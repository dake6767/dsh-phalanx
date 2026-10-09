import { expect, it } from 'vitest'
import { PluginMarket } from '../src/use-cases/plugin-market.js'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'
import { SignedPluginDownloadTokens } from '../src/adapters/plugin-download-tokens.js'
it('publishes checked artifacts immediately, joins native versions and rejects expired or cross-member downloads', async () => {
  const actor = { username: 'admin', spaceId: 'space-admin', sessionEpoch: 0 }
  const member = { username: 'member', spaceId: 'space-member', sessionEpoch: 0 }
  let now = 1000; let installed: readonly { packageName: string, version: string }[] = []; let url = ''; let managed = false
  const prepared = { packageName: 'plugin', version: '2.0.0', integrity: 'sha512-content', runtimeRevision: 'revision', artifact: 'artifacts/hash', title: 'Plugin', description: 'Description', bundlePatch: '[]', dependencies: {} }
  let row: LibraryPlugin = { ...prepared, current: prepared, stage: 'available', published: false }
  const instance = { userId: 'member', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1 }
  const market = new PluginMarket({ get: username => ({ ...(username === 'admin' ? actor : member), username, admin: username === 'admin', groupId: 'group', email: '', disabled: false, createdAt: 0, updatedAt: 0 }) }, {
    list: () => [row], save: value => { row = value },
  }, { list: async () => installed, install: async (_instance, _origin, value) => { url = value; installed = [{ packageName: 'plugin', version: '2.0.0' }]; return 'applied' } },
  { ensure: async () => ({ ...instance, managedSnapshot: managed ? ['plugin@1.0.0:previous-content'] : [] }) }, new SignedPluginDownloadTokens('fixture-key'), { now: () => now }, 'revision')
  const origin = new URL('http://localhost'); const signal = new AbortController().signal
  expect(await market.list(member, origin, signal)).toEqual([])
  expect(() => market.publish(member, 'plugin', true)).toThrow(expect.objectContaining({ code: 'admin-required' }))
  market.publish(actor, 'plugin', true)
  expect((await market.list(member, origin, signal))[0]?.status).toBe('install')
  installed = [{ packageName: 'plugin', version: '3.0.0' }]; expect((await market.list(member, origin, signal))[0]?.status).toBe('installed')
  installed = [{ packageName: 'plugin', version: '2.0.0+build' }]; expect((await market.list(member, origin, signal))[0]?.status).toBe('installed')
  installed = [{ packageName: 'plugin', version: '2.0.0-rc.1' }]; expect((await market.list(member, origin, signal))[0]?.status).toBe('update')
  installed = [{ packageName: 'plugin', version: '1.0.0' }]; expect((await market.list(member, origin, signal))[0]?.status).toBe('update')
  managed = true
  expect((await market.list(member, origin, signal))[0]?.status).toBe('installed')
  await expect(market.install(member, 'plugin', origin, signal)).rejects.toMatchObject({ code: 'plugin-market-unavailable' })
  expect(url).toBe('')
  managed = false
  await market.install(member, 'plugin', origin, signal)
  expect((await market.list(member, origin, signal))[0]?.status).toBe('installed')
  const token = new URL(url).pathname.slice('/plugin-archive/'.length, -'.tgz'.length)
  expect(market.download(token, 'member')).toEqual(prepared)
  expect(() => market.download(token, 'other')).toThrow(expect.objectContaining({ code: 'plugin-download-denied' }))
  expect(() => market.download(token + 'x', 'member')).toThrow(expect.objectContaining({ code: 'plugin-download-denied' }))
  now += 120000; expect(() => market.download(token, 'member')).toThrow(expect.objectContaining({ code: 'plugin-download-denied' }))
  market.publish(actor, 'plugin', false); expect(await market.list(member, origin, signal)).toEqual([])
  expect(installed).toHaveLength(1)
  row = { ...row, stage: 'failed', current: null }
  expect(() => market.publish(actor, 'plugin', true)).toThrow(expect.objectContaining({ code: 'plugin-market-unavailable' }))
})
