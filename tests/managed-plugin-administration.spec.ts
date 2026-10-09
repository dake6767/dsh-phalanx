import { expect, it } from 'vitest'
import { ManagedPluginAdministration } from '../src/use-cases/managed-plugin-administration.js'
import type { CommunityAccountRecord } from '../src/domain/community-account.js'
import type { PreparedPlugin } from '../src/domain/plugin-library.js'
import type { CommunityRuntimeStatus } from '../src/ports/community-runtime.js'

it('projects startup drift, changes grants without interruption, and restarts only pending running members', async () => {
  const admin: CommunityAccountRecord = { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0, admin: true, disabled: false, groupId: 'admin', email: '', createdAt: 0, updatedAt: 0 }
  const member = { ...admin, username: 'member', spaceId: 'member-space', groupId: 'ordinary', admin: false }
  const stopped = { ...member, username: 'stopped', spaceId: 'stopped-space' }
  const groups = [{ id: 'admin', name: 'Admin', kind: 'admin' as const, isDefault: false, memberCount: 1 }, { id: 'ordinary', name: 'Ordinary', kind: 'ordinary' as const, isDefault: true, memberCount: 2 }]
  const plugin: PreparedPlugin = { packageName: 'private', version: '1.0.0', integrity: 'hash', artifact: 'artifact', runtimeRevision: 'revision', title: 'Private', description: '', bundlePatch: '[]', dependencies: {} }
  let granted: readonly string[] = []
  let instance = { userId: 'member', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1, managedSnapshot: [] as string[], managedFailures: ['private'] }
  const restarted: string[] = []
  const service = new ManagedPluginAdministration({ get: username => [admin, member, stopped].find(account => account.username === username), list: () => [admin, member, stopped], listGroups: () => groups },
    { list: () => [{ ...plugin, stage: 'available', current: plugin, published: false }, { ...plugin, packageName: 'failed', stage: 'failed', current: null, published: false }, { ...plugin, packageName: 'old', stage: 'available', current: { ...plugin, runtimeRevision: 'old' }, published: false }], save: () => {} },
    { get: () => granted, set: (_id, next) => { granted = next }, remove: () => {}, retainGroups: () => {} },
    { effective: () => granted.length ? [plugin] : [] },
    { status: (username): CommunityRuntimeStatus => username === 'member' ? { state: 'ready', instance } : { state: 'stopped' } },
    { restart: async actor => { restarted.push(actor.username); instance = { ...instance, managedSnapshot: ['private@1.0.0:hash'], managedFailures: [] }; return instance } }, 'revision')
  expect(service.group(admin, 'ordinary').pendingMembers).toEqual([])
  expect(service.save(admin, 'ordinary', ['private']).pendingMembers).toEqual(['member'])
  expect(restarted).toEqual([])
  expect(service.group(admin, 'ordinary').plugins[0]?.failures).toEqual([{ username: 'member', code: 'plugin-managed-load-failed' }])
  await service.restartAffected(admin, 'ordinary', new URL('http://localhost'))
  expect(restarted).toEqual(['member']); expect(service.group(admin, 'ordinary').pendingMembers).toEqual([])
  expect(service.save(admin, 'ordinary', []).pendingMembers).toEqual(['member'])
  expect(() => service.save(admin, 'admin', [])).toThrow(expect.objectContaining({ code: 'group-protected' }))
  expect(() => service.save(member, 'ordinary', [])).toThrow(expect.objectContaining({ code: 'admin-required' }))
  expect(() => service.save(admin, 'ordinary', ['failed'])).toThrow(expect.objectContaining({ code: 'plugin-grant-invalid' }))
  expect(() => service.save(admin, 'ordinary', ['old'])).toThrow(expect.objectContaining({ code: 'plugin-grant-invalid' }))
  granted = ['old']; expect(service.save(admin, 'ordinary', ['old']).plugins.find(row => row.packageName === 'old')).toMatchObject({ granted: true, available: false })
  expect(() => service.save(admin, 'ordinary', ['missing'])).toThrow(expect.objectContaining({ code: 'plugin-grant-invalid' }))
})
