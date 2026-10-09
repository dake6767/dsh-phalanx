import { expect, it } from 'vitest'
import { MemberManagedPlugins } from '../src/use-cases/member-managed-plugins.js'
import type { LibraryPlugin, PreparedPlugin } from '../src/domain/plugin-library.js'

it('selects only compatible prepared current plugins, with implicit admin access and explicit ordinary grants', () => {
  const current: PreparedPlugin = { packageName: 'good', version: '1.0.0', integrity: 'hash', artifact: 'artifact', runtimeRevision: 'current', title: '', description: '', dependencies: {}, bundlePatch: '[]' }
  const rows: LibraryPlugin[] = [
    { ...current, current, stage: 'available', published: false },
    { ...current, packageName: 'other', current: { ...current, packageName: 'other' }, stage: 'available', published: false },
    { ...current, packageName: 'old', current: { ...current, packageName: 'old', runtimeRevision: 'old' }, stage: 'available', published: false },
    { ...current, packageName: 'failed', current: null, stage: 'failed', published: false },
  ]
  let groupId = 'ordinary'; let disabled = false
  const grants = { get: () => ['good', 'old', 'failed'], set: () => {}, remove: () => {}, retainGroups: () => {} }
  const service = new MemberManagedPlugins({ get: () => ({ username: 'member', groupId, disabled, admin: false, email: '', spaceId: 'space', sessionEpoch: 0, createdAt: 0, updatedAt: 0 }),
    listGroups: () => [{ id: 'ordinary', name: 'Ordinary', kind: 'ordinary', memberCount: 1, isDefault: true }, { id: 'admin', name: 'Admin', kind: 'admin', memberCount: 1, isDefault: false }] }, { list: () => rows, remove: () => {}, save: () => {} }, grants, 'current')
  expect(service.effective('member').map(row => row.packageName)).toEqual(['good'])
  expect(service.yielding(service.effective('member'), [{ packageName: 'good', entries: [{ id: 'old-entry', name: 'good/host' }] }, { packageName: 'other', entries: [{ id: 'other', name: 'other' }] }])).toEqual([{ id: 'old-entry', name: 'good/host', disabled: true }])
  expect(service.yielding([], [{ packageName: 'good', entries: [{ id: 'old-entry', name: 'good/host' }] }])).toEqual([])
  rows[0] = { ...rows[0]!, removing: true }; expect(service.effective('member')).toEqual([])
  rows[0] = { ...rows[0]!, removing: false }
  groupId = 'admin'; expect(service.effective('member').map(row => row.packageName)).toEqual(['good', 'other'])
  disabled = true; expect(service.effective('member')).toEqual([])
  disabled = false; groupId = 'removed'; expect(service.effective('member')).toEqual([])
})
it('unions published selections with grants, deduplicates overlap and retains incompatible selections for recovery', () => {
  const plugin: PreparedPlugin = { packageName: 'selected', version: '1.0.0', integrity: 'hash', artifact: 'artifact', runtimeRevision: 'current', title: '', description: '', dependencies: {}, bundlePatch: '[]' }
  let rows: LibraryPlugin[] = [{ ...plugin, current: plugin, stage: 'available', published: true }]
  let granted: string[] = [], selected = ['selected'], spaceId = 'space'
  const service = new MemberManagedPlugins({ get: () => ({ username: 'member', groupId: 'g', disabled: false, admin: false, email: '', spaceId, sessionEpoch: 0, createdAt: 0, updatedAt: 0 }), listGroups: () => [{ id: 'g', name: 'g', kind: 'ordinary', isDefault: true, memberCount: 1 }] },
    { list: () => rows, save: () => {}, remove: () => {} }, { get: () => granted, set: () => {}, remove: () => {}, retainGroups: () => {} }, 'current',
    { get: id => id === 'space' ? selected : [], retainPackages: names => { selected = selected.filter(name => names.includes(name)) } })
  expect(service.effective('member')).toEqual([plugin]); expect(service.granted('member')).toEqual([])
  granted = ['selected']; expect(service.effective('member')).toEqual([plugin]); expect(service.granted('member')).toEqual(['selected'])
  granted = []; rows = [{ ...rows[0]!, incompatible: true, published: false, restorePublication: true }]
  expect(service.effective('member')).toEqual([]); service.recover(); expect(selected).toEqual(['selected'])
  rows = [{ ...rows[0]!, incompatible: false, published: true, current: { ...plugin, version: '2.0.0' } }]
  expect(service.effective('member')[0]?.version).toBe('2.0.0')
  spaceId = 'replacement-space'; expect(service.effective('member')).toEqual([]); spaceId = 'space'
  rows = [{ ...rows[0]!, published: false, restorePublication: false }]; service.recover(); expect(selected).toEqual([])
})
