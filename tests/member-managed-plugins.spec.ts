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
    listGroups: () => [{ id: 'ordinary', name: 'Ordinary', kind: 'ordinary', memberCount: 1, isDefault: true }, { id: 'admin', name: 'Admin', kind: 'admin', memberCount: 1, isDefault: false }] }, { list: () => rows, save: () => {} }, grants, 'current')
  expect(service.effective('member').map(row => row.packageName)).toEqual(['good'])
  groupId = 'admin'; expect(service.effective('member').map(row => row.packageName)).toEqual(['good', 'other'])
  disabled = true; expect(service.effective('member')).toEqual([])
  disabled = false; groupId = 'removed'; expect(service.effective('member')).toEqual([])
})
