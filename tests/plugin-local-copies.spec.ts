import { expect, it } from 'vitest'
import { PluginLocalCopies } from '../src/use-cases/plugin-local-copies.js'
import { MemberManagedPlugins } from '../src/use-cases/member-managed-plugins.js'
import { MemberPluginAccess } from '../src/use-cases/member-plugin-access.js'
import { PluginUpstreamAccess } from '../src/use-cases/plugin-upstream-access.js'
import type { LibraryPlugin, PreparedPlugin } from '../src/domain/plugin-library.js'

it('keeps immutable maintainer choices separate from grants and blocks local-copy credentials in projection and gateway', () => {
  const current: PreparedPlugin = { packageName: 'shared', version: '1.0.0', integrity: 'hash', artifact: 'artifact', runtimeRevision: 'revision', title: '', description: '', dependencies: {}, bundlePatch: '[]' }
  const a = { username: 'a', groupId: 'g', disabled: false, admin: false, email: '', spaceId: 'a-space', sessionEpoch: 0, createdAt: 0, updatedAt: 0 }, b = { ...a, username: 'b', spaceId: 'b-space' }
  let starting = false, runningLocal = false, credential = 'platform-fixture-key'
  let accountA = a, granted = ['shared'], selected = ['shared'], expertOwned = false
  let row: LibraryPlugin = { ...current, current, stage: 'available', published: true, provenance: { maintainer: { username: a.username, spaceId: a.spaceId }, anonymous: false, versions: [] } }
  const accounts = { get: (username: string) => username === 'a' ? accountA : b, listGroups: () => [{ id: 'g', name: 'g', kind: accountA.admin ? 'admin' as const : 'ordinary' as const, isDefault: true, memberCount: 2 }] }, library = { list: () => [row], save: () => {}, remove: () => {} }
  const grants = { get: () => granted, set: () => {}, remove: () => {}, retainGroups: () => {} }, choices = { get: () => selected, retainPackages: () => {} }
  const preferences = new Map<string, readonly string[]>(), local = new PluginLocalCopies(accounts, library, grants, choices, { get: id => preferences.get(id) ?? [], set: (id, names) => { preferences.set(id, names) } }, 'revision', { plugins: () => expertOwned ? [current] : [] }, { list: () => [{ name: 'search', baseUrl: 'https://provider.example', headers: [], credential }] })
  const managed = new MemberManagedPlugins(accounts, library, grants, 'revision', choices, local, undefined, { list: () => [{ name: 'search', baseUrl: 'https://provider.example', headers: [], credential }] })
  const projection = new MemberPluginAccess(managed, { get: () => ({ environment: [{ name: 'PLATFORM_TOKEN', value: '{access-token}' }], entriesYaml: '', entries: { entry: { endpoint: '{upstream:search}' } }, revision: 'access' }), list: () => ({}), save: () => {}, remove: () => {} })
  const gateway = new PluginUpstreamAccess(accounts, { resolve: () => ({ username: 'a', spaceId: accountA.spaceId }) }, library, grants, { list: () => [{ name: 'search', baseUrl: 'https://provider.example', headers: [], credential: 'platform-fixture-key' }] }, 'revision', local, { status: () => starting ? { state: 'starting' } : ({ state: 'ready', instance: { userId: 'a', origin: 'http://instance', launchUrl: 'http://instance', processId: 1, localPluginSnapshot: runningLocal ? ['shared'] : [] } }) })
  expect(local.view(b, 'shared')).toBeUndefined(); expect(() => local.set(b, 'shared', true)).toThrow(expect.objectContaining({ code: 'plugin-local-copy-unavailable' }))
  local.set(a, 'shared', true)
  expect(managed.effective('a')).toEqual([]); expect(managed.effective('b')).toEqual([current]); expect(managed.granted('a')).toEqual(['shared'])
  expect(projection.snapshot('a')).toEqual([]); expect(projection.resolve(managed.effective('a'), { url: 'https://platform.example', token: 'member-token' })).toEqual({ environment: {}, entries: {}, snapshot: [] })
  expect(() => gateway.authorize('shared', 'search', { authorization: 'Bearer member-token' })).toThrow(expect.objectContaining({ status: 403 }))
  granted = []; expect(managed.effective('a')).toEqual([]) // publication selections also yield
  runningLocal = true; local.set(a, 'shared', false); expect(managed.effective('a')).toEqual([current])
  expect(() => gateway.authorize('shared', 'search', { authorization: 'Bearer member-token' })).toThrow(expect.objectContaining({ status: 403 }))
  runningLocal = false; expect(gateway.authorize('shared', 'search', { authorization: 'Bearer member-token' }).username).toBe('a')
  local.set(a, 'shared', true); accountA = { ...a, spaceId: 'replacement-space' }
  expect(local.enabled('a', 'shared')).toBe(false); expect(() => local.set(a, 'shared', false)).toThrow(expect.objectContaining({ code: 'sign-in-required' }))
  accountA = a; row = { ...row, provenance: { ...row.provenance!, maintainer: { username: b.username, spaceId: b.spaceId } } }
  expect(local.enabled('a', 'shared')).toBe(false); expect(local.view(a, 'shared')).toBeUndefined(); expect(managed.effective('a')).toEqual([current])
  runningLocal = true; expect(() => gateway.authorize('shared', 'search', { authorization: 'Bearer member-token' })).toThrow(expect.objectContaining({ status: 403 }))
  // Driver captured a local startup, then ownership changes while it awaits readiness.
  starting = true; runningLocal = false
  expect(() => gateway.authorize('shared', 'search', { authorization: 'Bearer member-token' })).toThrow(expect.objectContaining({ status: 403 }))
  starting = false; expect(gateway.authorize('shared', 'search', { authorization: 'Bearer member-token' }).username).toBe('a')
  row = { ...row, published: false }; selected = []
  expect(local.view(b, 'shared')).toBeUndefined()
  row = { ...row, provenance: { ...row.provenance!, maintainer: { username: a.username, spaceId: a.spaceId } } }
  granted = []; expertOwned = true
  expect(local.view(a, 'shared')).toEqual({ enabled: true })
  local.set(a, 'shared', false)
  expect(local.view(a, 'shared')).toEqual({ enabled: false })
  expertOwned = false; accountA = { ...a, admin: true }
  expect(local.view(accountA, 'shared')).toBeUndefined()
  granted = ['shared']; expect(local.view(accountA, 'shared')).toEqual({ enabled: false })
  local.set(accountA, 'shared', true)
  row = { ...row, published: true }; selected = ['shared']; granted = []; credential = ''
  expect(local.view(accountA, 'shared')).toBeUndefined(); expect(local.enabled('a', 'shared')).toBe(false)
  expect(() => local.set(accountA, 'shared', false)).toThrow(expect.objectContaining({ code: 'plugin-local-copy-unavailable' }))
})
