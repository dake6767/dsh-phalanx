import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilePluginGrants } from '../src/adapters/plugin-grants.js'
import { expect, it } from 'vitest'
import { ManagedPluginAdministration } from '../src/use-cases/managed-plugin-administration.js'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'
import type { PreparedPlugin } from '../src/domain/plugin-library.js'
import type { CommunityUserInstance, CommunityRuntimeStatus } from '../src/ports/community-runtime.js'

it('projects startup drift, changes grants without interruption, and restarts only pending running members', async () => {
  const admin: CommunityAccountRecord = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  const member = { ...admin, username: 'member', spaceId: 'member-space', groupId: 'ordinary', admin: false }
  const stopped = { ...member, username: 'stopped', spaceId: 'stopped-space' }
  const groups = [{ id: 'admin', name: 'Admin', kind: 'admin' as const, isDefault: false, memberCount: 1 }, { id: 'ordinary', name: 'Ordinary', kind: 'ordinary' as const, isDefault: true, memberCount: 2 }]
  const plugin: PreparedPlugin = { packageName: 'private', version: '1.0.0', integrity: 'hash', artifact: 'artifact', runtimeRevision: 'revision', title: 'Private', description: '', bundlePatch: '[]', dependencies: {} }
  let granted: readonly string[] = []
  let instance: CommunityUserInstance = { userId: 'member', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1, pluginAccessSnapshot: [] as string[], managedSnapshot: [] as string[], managedFailures: ['private'] }
  let accessSnapshot: string[] = []
  const restarted: string[] = []
  const service = new ManagedPluginAdministration({ get: username => [admin, member, stopped].find(account => account.username === username), list: () => [admin, member, stopped], listGroups: () => groups },
    { list: () => [{ ...plugin, stage: 'available', current: plugin, published: false }, { ...plugin, packageName: 'failed', stage: 'failed', current: null, published: false }, { ...plugin, packageName: 'old', stage: 'available', current: { ...plugin, runtimeRevision: 'old' }, published: false }], remove: () => {}, save: () => {} },
    { get: () => granted, preinstalls: () => [], configure: (_id, next) => { granted = next }, set: (_id, next) => { granted = next }, remove: () => {}, retainGroups: () => {} },
    { effective: () => granted.length ? [plugin] : [] },
    { status: (username): CommunityRuntimeStatus => username === 'member' ? { state: 'ready', instance } : { state: 'stopped' } },
    { restart: async actor => { restarted.push(actor.username); instance = { ...instance, managedSnapshot: ['private@1.0.0:hash'], managedFailures: [] }; return instance } }, 'revision', { snapshot: () => accessSnapshot })
  expect(service.group(admin, 'ordinary').pendingMembers).toEqual([])
  expect(service.save(admin, 'ordinary', ['private'], [], service.group(admin, 'ordinary').revision).pendingMembers).toEqual(['member'])
  expect(restarted).toEqual([])
  expect(service.group(admin, 'ordinary').plugins[0]?.failures).toEqual([{ username: 'member', code: 'plugin-managed-load-failed' }])
  const beforeInspection = service.group(admin, 'ordinary').revision
  Object.assign(instance, { inspection: 'checking', managedSnapshot: ['private@1.0.0:hash'] })
  expect(service.group(admin, 'ordinary').plugins[0]).toMatchObject({ checking: ['member'], failures: [{ username: 'member', code: 'plugin-managed-load-failed' }] })
  expect(service.group(admin, 'ordinary').revision).toBe(beforeInspection)
  Object.assign(instance, { inspection: 'complete' })
  expect(service.group(admin, 'ordinary').plugins[0]?.checking).toBeUndefined()
  Object.assign(instance, { managedSnapshot: [] })
  await service.restartAffected(admin, 'ordinary', new URL('http://localhost'))
  expect(restarted).toEqual(['member']); expect(service.group(admin, 'ordinary').pendingMembers).toEqual([])
  accessSnapshot = ['private:access-new']; expect(service.group(admin, 'ordinary').pendingMembers).toEqual(['member'])
  instance = { ...instance, pluginAccessSnapshot: accessSnapshot }; expect(service.group(admin, 'ordinary').pendingMembers).toEqual([])
  expect(service.save(admin, 'ordinary', [], [], service.group(admin, 'ordinary').revision).pendingMembers).toEqual(['member'])
  expect(service.grantCount('admin')).toBe(0)
  expect(service.group(admin, 'admin').plugins.every(row => !row.granted)).toBe(true)
  expect(service.save(admin, 'admin', ['private'], [], service.group(admin, 'admin').revision).plugins[0]?.granted).toBe(true)
  expect(service.grantCount('admin')).toBe(1)
  expect(service.save(admin, 'admin', [], [], service.group(admin, 'admin').revision).plugins.every(row => !row.granted)).toBe(true)
  expect(() => service.save(member, 'ordinary', [], [], service.group(admin, 'ordinary').revision)).toThrow(expect.objectContaining({ code: 'admin-required' }))
  expect(() => service.save(admin, 'ordinary', ['failed'], [], service.group(admin, 'ordinary').revision)).toThrow(expect.objectContaining({ code: 'plugin-grant-invalid' }))
  expect(() => service.save(admin, 'ordinary', ['old'], [], service.group(admin, 'ordinary').revision)).toThrow(expect.objectContaining({ code: 'plugin-grant-invalid' }))
  granted = ['old']; expect(service.save(admin, 'ordinary', ['old'], [], service.group(admin, 'ordinary').revision).plugins.find(row => row.packageName === 'old')).toMatchObject({ granted: true, available: false })
  expect(() => service.save(admin, 'ordinary', ['missing'], [], service.group(admin, 'ordinary').revision)).toThrow(expect.objectContaining({ code: 'plugin-grant-invalid' }))
})

it('saves mutually exclusive lists against a stable revision and derives credential hints from current library configuration', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-group-'))
  try {
    const actor: CommunityAccountRecord = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
    const group = { id: 'team', name: 'Team', kind: 'ordinary' as const, isDefault: true, memberCount: 0 }
    const plugin: PreparedPlugin = { packageName: 'plugin', version: '1.0.0', integrity: 'hash', artifact: 'artifact', runtimeRevision: 'runtime', title: 'Plugin', description: '', bundlePatch: '[]', dependencies: {} }
    let credential = '', incompatible = false
    const store = new FilePluginGrants(join(root, 'grants.json'))
    const service = new ManagedPluginAdministration({ get: () => actor, list: () => [actor], listGroups: () => [group] },
      { list: () => [{ ...plugin, stage: 'available', current: plugin, published: false, ...(incompatible ? { incompatible: true } : {}) }], save: () => {}, remove: () => {} }, store,
      { effective: () => [] }, { status: () => ({ state: 'stopped' }) }, { restart: async () => { throw Error('No restart during configuration') } }, 'runtime', undefined,
      { list: () => [{ name: 'upstream', baseUrl: 'https://example.test', credential, headers: [] }] })
    const current = () => service.group(actor, group.id)
    const save = (controlled: readonly string[], preinstalled: readonly string[], revision = current().revision) => service.save(actor, group.id, controlled, preinstalled, revision)
    const initial = current(); expect(initial.revision).toEqual(expect.any(String))
    expect(initial.plugins[0]).toMatchObject({ granted: false, preinstalled: false, hasPlatformCredential: false })
    save(['plugin'], [])
    expect(() => save([], ['plugin'], initial.revision)).toThrow(expect.objectContaining({ code: 'plugin-impact-changed' }))
    const moved = save([], ['plugin'])
    expect(moved.plugins[0]).toMatchObject({ granted: false, preinstalled: true })
    expect(() => save(['plugin'], ['plugin'])).toThrow(expect.objectContaining({ code: 'plugin-grant-invalid' }))
    expect(current().plugins[0]).toMatchObject({ granted: false, preinstalled: true })
    expect(save(['plugin'], []).plugins[0]).toMatchObject({ granted: true, preinstalled: false })
    const beforeCredential = current().revision; credential = 'shared-fixture'
    expect(current().plugins[0]?.hasPlatformCredential).toBe(true)
    expect(() => save([], ['plugin'], beforeCredential)).toThrow(expect.objectContaining({ code: 'plugin-impact-changed' }))
    expect(() => save([], ['missing'])).toThrow(expect.objectContaining({ code: 'plugin-grant-invalid' }))
    incompatible = true
    expect(save(['plugin'], []).plugins[0]).toMatchObject({ granted: true, available: false })
    expect(() => save([], ['plugin'])).toThrow(expect.objectContaining({ code: 'plugin-grant-invalid' }))
    expect(save([], []).plugins[0]).toMatchObject({ granted: false, preinstalled: false })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
