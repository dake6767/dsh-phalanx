import { expect, it } from 'vitest'
import { PluginMarket } from '../src/use-cases/plugin-market.js'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'

it('records selections without native installation, projects restart state and protects native and granted plugins', async () => {
  const admin = { username: 'admin', spaceId: 'a', sessionEpoch: 0, admin: true, groupId: 'admins', email: '', disabled: false, createdAt: 0, updatedAt: 0 }
  const member = { ...admin, username: 'member', spaceId: 'm', admin: false, groupId: 'members' }
  const plugin = { packageName: 'plugin', version: '1.0.0', integrity: 'hash', runtimeRevision: 'revision', artifact: 'artifacts/hash', title: 'Plugin', description: '', bundlePatch: '[]', dependencies: {} }
  let row: LibraryPlugin = { ...plugin, current: plugin, stage: 'available', published: true }
  let installed: readonly { packageName: string, version: string }[] = [], granted: string[] = [], selected: string[] = [], snapshot: string[] = [], removalFails = false
  const market = new PluginMarket({ get: username => username === 'admin' ? admin : member, list: () => [admin, member] }, { list: () => [row], remove: () => {}, save: next => { row = next } }, { list: async () => installed },
    { ensure: async () => ({ userId: 'member', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1, managedSnapshot: snapshot }) },
    { get: () => selected, set: (_, names) => { selected = [...names] }, members: () => selected.length ? ['m'] : [], removePackage: () => { if (removalFails) throw Error('storage failed'); selected = [] }, retainPackages: () => {} },
    { granted: () => granted, effective: () => granted.length || row.published && selected.length ? [row.current!] : [] }, 'revision')
  const origin = new URL('http://localhost'), signal = new AbortController().signal
  const list = () => market.list(member, origin, signal)
  expect((await list()).plugins[0]?.status).toBe('install')
  installed = [{ packageName: 'plugin', version: '0.9.0' }]; expect((await list()).plugins[0]?.status).toBe('native')
  await expect(market.install(member, 'plugin', origin, signal)).rejects.toThrow()
  installed = []; expect(await market.install(member, 'plugin', origin, signal)).toEqual({ application: 'restart-required' })
  expect(selected).toEqual(['plugin']); expect((await list()).plugins[0]?.status).toBe('selected'); expect((await list()).pending).toBe(true)
  snapshot = ['plugin@1.0.0:hash']; expect((await list()).pending).toBe(false)
  granted = ['plugin']; expect((await list()).plugins[0]?.status).toBe('managed')
  await expect(market.uninstall(member, 'plugin', origin, signal)).rejects.toThrow()
  granted = []; await market.uninstall(member, 'plugin', origin, signal); expect(selected).toEqual([]); expect((await list()).pending).toBe(true)
  await market.install(member, 'plugin', origin, signal)
  expect(() => market.publish(admin, 'plugin', false)).toThrow()
  market.publish(admin, 'plugin', false, { confirmed: true, selectedMembers: 1 })
  expect(selected).toEqual([]); expect((await list()).plugins).toEqual([]); expect((await list()).pending).toBe(true)
  expect(() => market.publish(member, 'plugin', true)).toThrow()
  market.publish(admin, 'plugin', true)
  await market.install(member, 'plugin', origin, signal)
  removalFails = true
  expect(() => market.publish(admin, 'plugin', false, { confirmed: true, selectedMembers: 1 })).toThrow()
  expect(row.published).toBe(false)
  expect(() => market.publish(admin, 'plugin', true)).toThrow()
  expect(row.published).toBe(false)
  removalFails = false
  market.publish(admin, 'plugin', true)
  expect(selected).toEqual([])
  expect((await list()).plugins[0]?.status).toBe('install')
})
