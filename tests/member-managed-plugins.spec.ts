import { expect, it } from 'vitest'
import { MemberManagedPlugins } from '../src/use-cases/member-managed-plugins.js'
import type { LibraryPlugin, PreparedPlugin } from '../src/domain/plugin-library.js'

it('selects compatible prepared plugins only from explicit grants for both group roles', async () => {
  const current: PreparedPlugin = {
    packageName: 'good',
    version: '1.0.0',
    integrity: 'hash',
    artifact: 'artifact',
    runtimeRevision: 'current',
    title: '',
    description: '',
    dependencies: {},
    bundlePatch: '[]',
  }
  const rows: LibraryPlugin[] = [
    { ...current, current, stage: 'available', published: false },
    { ...current, packageName: 'other', current: { ...current, packageName: 'other' }, stage: 'available', published: false },
    { ...current, packageName: 'old', current: { ...current, packageName: 'old', runtimeRevision: 'old' }, stage: 'available', published: false },
    { ...current, packageName: 'failed', current: null, stage: 'failed', published: false },
  ]
  let groupId = 'ordinary'
  let disabled = false
  let adminGrants: string[] = []
  const grants = {
    get: async (id: string) => (id === 'admin' ? adminGrants : ['good', 'old', 'failed']),
    set: async () => {},
    remove: async () => {},
    retainGroups: async () => {},
  }
  const service = new MemberManagedPlugins(
    {
      get: async () => ({ username: 'member', groupId, disabled, admin: false, email: '', spaceId: 'space', sessionEpoch: 0, createdAt: 0, updatedAt: 0 }),
      listGroups: async () => [
        { id: 'ordinary', name: 'Ordinary', kind: 'ordinary', memberCount: 1, isDefault: true },
        { id: 'admin', name: 'Admin', kind: 'admin', memberCount: 1, isDefault: false },
      ],
    },
    { list: async () => rows, remove: async () => {}, save: async () => {} },
    grants,
    'current',
  )
  expect((await service.effective('member')).map(row => row.packageName)).toEqual(['good'])
  expect(
    service.yielding(await service.effective('member'), [
      { packageName: 'good', entries: [{ id: 'old-entry', name: 'good/host' }] },
      { packageName: 'other', entries: [{ id: 'other', name: 'other' }] },
    ]),
  ).toEqual([{ id: 'old-entry', name: 'good/host', disabled: true }])
  expect(service.yielding([], [{ packageName: 'good', entries: [{ id: 'old-entry', name: 'good/host' }] }])).toEqual([])
  rows[0] = { ...rows[0]!, removing: true }
  expect(await service.effective('member')).toEqual([])
  rows[0] = { ...rows[0]!, removing: false }
  groupId = 'admin'
  expect(await service.effective('member')).toEqual([])
  adminGrants = ['good']
  expect((await service.effective('member')).map(row => row.packageName)).toEqual(['good'])
  disabled = true
  expect(await service.effective('member')).toEqual([])
  disabled = false
  groupId = 'removed'
  expect(await service.effective('member')).toEqual([])
})
it('unions shared-credential published selections with grants, deduplicates overlap and retains incompatible selections for recovery', async () => {
  const plugin: PreparedPlugin = {
    packageName: 'selected',
    version: '1.0.0',
    integrity: 'hash',
    artifact: 'artifact',
    runtimeRevision: 'current',
    title: '',
    description: '',
    dependencies: {},
    bundlePatch: '[]',
  }
  let rows: LibraryPlugin[] = [{ ...plugin, current: plugin, stage: 'available', published: true }]
  let granted: string[] = [],
    selected = ['selected'],
    spaceId = 'space',
    credential = 'shared-fixture'
  const service = new MemberManagedPlugins(
    {
      get: async () => ({ username: 'member', groupId: 'g', disabled: false, admin: false, email: '', spaceId, sessionEpoch: 0, createdAt: 0, updatedAt: 0 }),
      listGroups: async () => [{ id: 'g', name: 'g', kind: 'ordinary', isDefault: true, memberCount: 1 }],
    },
    { list: async () => rows, save: async () => {}, remove: async () => {} },
    { get: async () => granted, set: async () => {}, remove: async () => {}, retainGroups: async () => {} },
    'current',
    {
      get: async id => (id === 'space' ? selected : []),
      retainPackages: async names => {
        selected = selected.filter(name => names.includes(name))
      },
    },
    undefined,
    undefined,
    { list: () => [{ name: 'upstream', baseUrl: 'https://example.test', headers: [], credential }] },
  )
  expect(await service.effective('member')).toEqual([plugin])
  expect(await service.granted('member')).toEqual([])
  credential = ''
  expect(await service.effective('member')).toEqual([])
  granted = ['selected']
  expect(await service.effective('member')).toEqual([plugin])
  granted = []
  credential = 'shared-fixture'
  granted = ['selected']
  expect(await service.effective('member')).toEqual([plugin])
  expect(await service.granted('member')).toEqual(['selected'])
  granted = []
  rows = [{ ...rows[0]!, incompatible: true, published: false, restorePublication: true }]
  expect(await service.effective('member')).toEqual([])
  await service.recover()
  expect(selected).toEqual(['selected'])
  rows = [{ ...rows[0]!, incompatible: false, published: true, current: { ...plugin, version: '2.0.0' } }]
  expect((await service.effective('member'))[0]?.version).toBe('2.0.0')
  spaceId = 'replacement-space'
  expect(await service.effective('member')).toEqual([])
  spaceId = 'space'
  rows = [{ ...rows[0]!, published: false, restorePublication: false }]
  await service.recover()
  expect(selected).toEqual([])
})

it('keeps expert acquisition outside the global layer except for a self-installed bundle, and withdraws only that source', async () => {
  const plugin: PreparedPlugin = {
    packageName: 'expert-tool',
    version: '1.0.0',
    integrity: 'hash',
    artifact: 'artifact',
    runtimeRevision: 'current',
    title: '',
    description: '',
    dependencies: {},
    bundlePatch: '[]',
  }
  let owned = true,
    granted: string[] = []
  const service = new MemberManagedPlugins(
    {
      get: async () => ({
        username: 'member',
        groupId: 'g',
        disabled: false,
        admin: false,
        email: '',
        spaceId: 'space',
        sessionEpoch: 0,
        createdAt: 0,
        updatedAt: 0,
      }),
      listGroups: async () => [{ id: 'g', name: 'g', kind: 'ordinary', isDefault: true, memberCount: 1 }],
    },
    { list: async () => [{ ...plugin, current: plugin, stage: 'available', published: false }], save: async () => {}, remove: async () => {} },
    { get: async () => granted, set: async () => {}, remove: async () => {}, retainGroups: async () => {} },
    'current',
    undefined,
    undefined,
    { plugins: async () => (owned ? [plugin] : []) },
  )
  expect(await service.accessible('member')).toEqual([plugin])
  expect(await service.effective('member')).toEqual([])
  expect(await service.effective('member', ['expert-tool'])).toEqual([plugin])
  granted = ['expert-tool']
  expect(await service.accessible('member')).toEqual([plugin])
  owned = false
  expect(await service.effective('member')).toEqual([plugin])
  granted = []
  expect(await service.accessible('member')).toEqual([])
})
