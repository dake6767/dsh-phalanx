import { accountState } from './support/account-state.js'
import { expect, it } from 'vitest'
import { PluginLocalCopies } from '../src/use-cases/plugin-local-copies.js'
import { MemberManagedPlugins } from '../src/use-cases/member-managed-plugins.js'
import { MemberPluginAccess } from '../src/use-cases/member-plugin-access.js'
import { PluginUpstreamAccess } from '../src/use-cases/plugin-upstream-access.js'
import type { LibraryPlugin, PreparedPlugin } from '../src/domain/plugin-library.js'

it('keeps immutable maintainer choices separate from grants and blocks local-copy credentials in projection and gateway', async () => {
  const current: PreparedPlugin = {
    packageName: 'shared',
    version: '1.0.0',
    integrity: 'hash',
    artifact: 'artifact',
    runtimeRevision: 'revision',
    title: '',
    description: '',
    dependencies: {},
    bundlePatch: '[]',
  }
  const a = { username: 'a', groupId: 'g', disabled: false, admin: false, email: '', spaceId: 'a-space', sessionEpoch: 0, createdAt: 0, updatedAt: 0 },
    b = { ...a, username: 'b', spaceId: 'b-space' }
  let starting = false,
    runningLocal = false,
    credential = 'platform-fixture-key'
  let accountA = a,
    granted = ['shared'],
    selected = ['shared'],
    expertOwned = false
  let row: LibraryPlugin = {
    ...current,
    current,
    stage: 'available',
    published: true,
    provenance: { maintainer: { username: a.username, spaceId: a.spaceId }, anonymous: false, versions: [] },
  }
  const accounts = {
      ...accountState(username => (username === 'a' ? accountA : b)),
      get: async (username: string) => (username === 'a' ? accountA : b),
      listGroups: async () => [{ id: 'g', name: 'g', kind: accountA.admin ? ('admin' as const) : ('ordinary' as const), isDefault: true, memberCount: 2 }],
    },
    library = { authorizationRevision: () => JSON.stringify(row), list: async () => [row], save: async () => {}, remove: async () => {} }
  const grants = {
      authorizationRevision: () => JSON.stringify(granted),
      get: async () => granted,
      set: async () => {},
      remove: async () => {},
      retainGroups: async () => {},
    },
    choices = { authorizationRevision: () => JSON.stringify(selected), get: async () => selected, retainPackages: async () => {} }
  const preferences = new Map<string, readonly string[]>(),
    local = new PluginLocalCopies(
      accounts,
      library,
      grants,
      choices,
      {
        authorizationRevision: () => JSON.stringify([...preferences]),
        get: async id => preferences.get(id) ?? [],
        set: async (id, names) => {
          preferences.set(id, names)
        },
      },
      'revision',
      { plugins: async () => (expertOwned ? [current] : []) },
      { list: () => [{ name: 'search', baseUrl: 'https://provider.example', headers: [], credential }] },
    )
  const managed = new MemberManagedPlugins(accounts, library, grants, 'revision', choices, local, undefined, {
    list: () => [{ name: 'search', baseUrl: 'https://provider.example', headers: [], credential }],
  })
  const projection = new MemberPluginAccess(managed, {
    get: () => ({
      environment: [{ name: 'PLATFORM_TOKEN', value: '{access-token}' }],
      entriesYaml: '',
      entries: { entry: { endpoint: '{upstream:search}' } },
      revision: 'access',
    }),
    list: () => ({}),
    save: async () => {},
    remove: async () => {},
  })
  const runningInstance = { userId: 'a', origin: 'http://instance', launchUrl: 'http://instance', processId: 1, localPluginSnapshot: [] as string[] }
  const gateway = new PluginUpstreamAccess(
    accounts,
    { resolve: () => ({ username: 'a', spaceId: accountA.spaceId }) },
    library,
    grants,
    { list: () => [{ name: 'search', baseUrl: 'https://provider.example', headers: [], credential: 'platform-fixture-key' }] },
    'revision',
    local,
    {
      status: () => {
        runningInstance.localPluginSnapshot = runningLocal ? ['shared'] : []
        return starting ? { state: 'starting' } : { state: 'ready', instance: runningInstance }
      },
    },
  )
  expect(await local.view(b, 'shared')).toBeUndefined()
  await expect(local.set(b, 'shared', true)).rejects.toThrow(expect.objectContaining({ code: 'plugin-local-copy-unavailable' }))
  await local.set(a, 'shared', true)
  expect(await managed.effective('a')).toEqual([])
  expect(await managed.effective('b')).toEqual([current])
  expect(await managed.granted('a')).toEqual(['shared'])
  expect(await projection.snapshot('a')).toEqual([])
  expect(await projection.resolve(await managed.effective('a'), { url: 'https://platform.example', token: 'member-token' })).toEqual({
    environment: {},
    entries: {},
    snapshot: [],
  })
  await expect(gateway.authorize('shared', 'search', { authorization: 'Bearer member-token' })).rejects.toThrow(expect.objectContaining({ status: 403 }))
  granted = []
  expect(await managed.effective('a')).toEqual([]) // publication selections also yield
  runningLocal = true
  await local.set(a, 'shared', false)
  expect(await managed.effective('a')).toEqual([current])
  await expect(gateway.authorize('shared', 'search', { authorization: 'Bearer member-token' })).rejects.toThrow(expect.objectContaining({ status: 403 }))
  runningLocal = false
  expect((await gateway.authorize('shared', 'search', { authorization: 'Bearer member-token' })).username).toBe('a')
  await local.set(a, 'shared', true)
  accountA = { ...a, spaceId: 'replacement-space' }
  expect(await local.enabled('a', 'shared')).toBe(false)
  await expect(local.set(a, 'shared', false)).rejects.toThrow(expect.objectContaining({ code: 'sign-in-required' }))
  accountA = a
  row = { ...row, provenance: { ...row.provenance!, maintainer: { username: b.username, spaceId: b.spaceId } } }
  expect(await local.enabled('a', 'shared')).toBe(false)
  expect(await local.view(a, 'shared')).toBeUndefined()
  expect(await managed.effective('a')).toEqual([current])
  runningLocal = true
  await expect(gateway.authorize('shared', 'search', { authorization: 'Bearer member-token' })).rejects.toThrow(expect.objectContaining({ status: 403 }))
  // Driver captured a local startup, then ownership changes while it awaits readiness.
  starting = true
  runningLocal = false
  await expect(gateway.authorize('shared', 'search', { authorization: 'Bearer member-token' })).rejects.toThrow(expect.objectContaining({ status: 403 }))
  starting = false
  expect((await gateway.authorize('shared', 'search', { authorization: 'Bearer member-token' })).username).toBe('a')
  row = { ...row, published: false }
  selected = []
  expect(await local.view(b, 'shared')).toBeUndefined()
  row = { ...row, provenance: { ...row.provenance!, maintainer: { username: a.username, spaceId: a.spaceId } } }
  granted = []
  expertOwned = true
  expect(await local.view(a, 'shared')).toEqual({ enabled: true })
  await local.set(a, 'shared', false)
  expect(await local.view(a, 'shared')).toEqual({ enabled: false })
  expertOwned = false
  accountA = { ...a, admin: true }
  expect(await local.view(accountA, 'shared')).toBeUndefined()
  granted = ['shared']
  expect(await local.view(accountA, 'shared')).toEqual({ enabled: false })
  await local.set(accountA, 'shared', true)
  row = { ...row, published: true }
  selected = ['shared']
  granted = []
  credential = ''
  expect(await local.view(accountA, 'shared')).toBeUndefined()
  expect(await local.enabled('a', 'shared')).toBe(false)
  await expect(local.set(accountA, 'shared', false)).rejects.toThrow(expect.objectContaining({ code: 'plugin-local-copy-unavailable' }))
})

it('retains both maintainer local-copy preferences when choices arrive together', async () => {
  const member = {
    username: 'member',
    spaceId: 'space',
    sessionEpoch: 0,
    admin: false,
    disabled: false,
    groupId: 'members',
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }
  const rows: LibraryPlugin[] = ['one', 'two'].map(packageName => {
    const current = {
      packageName,
      version: '1.0.0',
      integrity: 'hash',
      artifact: 'artifact',
      runtimeRevision: 'revision',
      title: '',
      description: '',
      bundlePatch: '[]',
      dependencies: {},
    }
    return { ...current, current, stage: 'available', published: false, provenance: { maintainer: member, anonymous: false, versions: [] } }
  })
  let preferences: readonly string[] = []
  const local = new PluginLocalCopies(
    { get: async () => member, listGroups: async () => [{ id: 'members', name: 'Members', kind: 'ordinary', isDefault: true, memberCount: 1 }] },
    { list: async () => rows, authorizationRevision: () => JSON.stringify(rows) },
    { get: async () => ['one', 'two'], authorizationRevision: () => 'fixed' },
    { get: async () => [], authorizationRevision: () => 'fixed' },
    {
      get: async () => preferences,
      set: async (_space, names) => {
        preferences = names
      },
      authorizationRevision: () => JSON.stringify(preferences),
    },
    'revision',
  )
  await Promise.all(['one', 'two'].map(name => local.set(member, name, true)))
  expect([...preferences].sort()).toEqual(['one', 'two'])
})
