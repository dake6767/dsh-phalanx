import { expect, it } from 'vitest'
import { MemberPluginAccess } from '../src/use-cases/member-plugin-access.js'
import { mergePluginConfig } from '../src/dsh/managed-plugin-access.js'

it('resolves only effective platform plugins and keeps access snapshots independent from upstream changes', () => {
  const plugin = { packageName: '@example/plugin', version: '1.0.0', integrity: 'hash', artifact: '', runtimeRevision: 'rev', title: '', description: '', bundlePatch: '', dependencies: {} }
  let effective = [plugin]
  const settings = { environment: [{ name: 'PLUGIN_KEY', value: '{access-token}' }, { name: 'PLUGIN_URL', value: '{upstream:search}/v1' }], entriesYaml: '', entries: { main: { apiKey: '{access-token}', endpoint: '{upstream:search}', tools: { a: true }, list: ['new'] } }, revision: 'saved-1' }
  const access = new MemberPluginAccess({ effective: () => effective }, { get: name => name === plugin.packageName ? settings : undefined, list: () => ({}), save: () => {}, remove: () => {} })
  const input = { url: 'http://127.0.0.1:1234/models', token: 'member-token' }
  const result = access.resolve(effective, input)
  expect(result.environment).toEqual({ PLUGIN_KEY: 'member-token', PLUGIN_URL: 'http://127.0.0.1:1234/plugins/%40example%2Fplugin/search/v1' })
  expect(result.entries[plugin.packageName]?.main).toMatchObject({ apiKey: 'member-token', endpoint: 'http://127.0.0.1:1234/plugins/%40example%2Fplugin/search' })
  expect(mergePluginConfig({ tools: { a: false, b: true }, list: ['old'], preserved: 1 }, result.entries[plugin.packageName]!.main!)).toMatchObject({ tools: { a: true, b: true }, list: ['new'], preserved: 1 })
  expect(access.snapshot('member')).toEqual(['@example/plugin:saved-1'])
  effective = [] // revoked, unpublished or removed; native installations are never inputs
  expect(access.snapshot('member')).toEqual([])
  expect(access.resolve(effective, input)).toEqual({ environment: {}, entries: {}, snapshot: [] })
  expect(access.resolve([{ ...plugin, packageName: 'unconfigured' }], input).snapshot).toEqual([])
})

it('projects the real grant-selection union once and drops access when publication or membership ends', async () => {
  const { MemberManagedPlugins } = await import('../src/use-cases/member-managed-plugins.js')
  const plugin = { packageName: 'plugin', version: '1.0.0', integrity: 'hash', artifact: '', runtimeRevision: 'rev', title: '', description: '', bundlePatch: '', dependencies: {} }
  let grants: string[] = [], selected: string[] = [], published = true, removed = false
  const managed = new MemberManagedPlugins({ get: () => ({ username: 'member', spaceId: 'space', sessionEpoch: 0, disabled: false, admin: false, groupId: 'g', email: '', createdAt: 0, updatedAt: 0 }), listGroups: () => [{ id: 'g', name: 'Members', kind: 'ordinary', isDefault: true, memberCount: 1 }] },
    { list: () => removed ? [] : [{ ...plugin, current: plugin, published, stage: 'available' }], save: () => {}, remove: () => {} }, { get: () => grants, set: () => {}, remove: () => {}, retainGroups: () => {} }, 'rev', { get: () => selected, retainPackages: () => {} }, undefined, undefined, { list: () => [{ name: 'shared', baseUrl: 'https://example.test', credential: 'fixture-key', headers: [] }] })
  const access = new MemberPluginAccess(managed, { get: () => ({ revision: 'configured', environment: [{ name: 'PLUGIN_KEY', value: '{access-token}' }], entriesYaml: '', entries: {} }), list: () => ({}), save: () => {}, remove: () => {} })
  expect(access.snapshot('member')).toEqual([]) // Native member bundles never enter the effective set.
  grants = ['plugin']; expect(access.snapshot('member')).toEqual(['plugin:configured'])
  selected = ['plugin']; expect(access.snapshot('member')).toEqual(['plugin:configured'])
  grants = []; expect(access.snapshot('member')).toEqual(['plugin:configured'])
  published = false; expect(access.snapshot('member')).toEqual([])
  grants = ['plugin']; expect(access.snapshot('member')).toEqual(['plugin:configured'])
  removed = true; expect(access.snapshot('member')).toEqual([])
})

it('projects only literal startup environment for successful native deliveries still present in the real inventory', () => {
  const account = { username: 'member', spaceId: 'space', sessionEpoch: 0, disabled: false, admin: false, groupId: 'g', email: '', createdAt: 0, updatedAt: 0 }
  let delivered = false, localCopy = false, source: 'selected' | 'preinstall' = 'selected'
  let settings = { revision: 'one', entriesYaml: '', entries: { main: { forbidden: 'entry-only' } }, environment: [
    { name: 'WELCOME', value: 'hello' }, { name: 'HOME', value: '/foreign' },
    { name: 'SHARED_TOKEN', value: '{access-token}' }, { name: 'SHARED_URL', value: '{upstream:shared}/v1' },
  ] }
  const store = { get: () => settings, list: () => ({}), save: () => {}, remove: () => {} }
  const access = new MemberPluginAccess({ effective: () => [], localSelection: () => localCopy ? ['plugin'] : [] }, store, { accounts: { get: () => account }, records: { get: () => delivered ? [{ packageName: 'plugin', source, version: '1.0.0' }] : [] } })
  const gateway = { url: 'https://platform.example', token: 'member-token' }, native = { username: 'member', installed: ['plugin'] }
  expect(access.resolve([], gateway, native)).toEqual({ environment: {}, entries: {}, snapshot: [] })
  delivered = true
  const result = access.resolve([], gateway, native)
  expect(result.environment).toEqual({ WELCOME: 'hello' }); expect(result.entries).toEqual({})
  expect(result.snapshot).toHaveLength(1); expect(access.snapshot('member', ['plugin'])).toEqual(result.snapshot)
  source = 'preinstall'; expect(access.resolve([], gateway, native)).toEqual(result)
  settings = { ...settings, revision: 'two', entries: { main: { forbidden: 'changed-entry' } }, environment: [...settings.environment.filter(row => row.name !== 'SHARED_TOKEN'), { name: 'SHARED_TOKEN', value: 'prefix-{access-token}' }] }
  expect(access.snapshot('member', ['plugin'])).toEqual(result.snapshot)
  expect(access.resolve([], gateway, { ...native, installed: [] })).toEqual({ environment: {}, entries: {}, snapshot: [] })
  expect(access.snapshot('member', [])).toEqual([])
  settings = { ...settings, environment: [{ name: 'WELCOME', value: 'updated' }] }
  expect(access.snapshot('member', ['plugin'])).not.toEqual(result.snapshot)
  localCopy = true; expect(access.resolve([], gateway, native)).toEqual({ environment: {}, entries: {}, snapshot: [] })
  localCopy = false; account.disabled = true; expect(access.resolve([], gateway, native)).toEqual({ environment: {}, entries: {}, snapshot: [] })
})

it('binds managed and native dependency templates to one declared ready generation and filters credential rows as a whole', () => {
  const plugin = { packageName: 'office', version: '1.0.0', integrity: 'hash', artifact: '', runtimeRevision: 'rev', title: '', description: '', bundlePatch: '', dependencies: {} }
  const account = { username: 'member', spaceId: 'space', sessionEpoch: 0, disabled: false, admin: false, groupId: 'g', email: '', createdAt: 0, updatedAt: 0 }
  let managed = [plugin], version = { id: 'first', mountedPath: '/runtime/first', identity: 'first', directory: '/host/first', pathDirectories: [], bytes: 1, isolated: true, checks: [], log: '', commands: [], commandPaths: {} }, removing = false, local = false
  const settings = { revision: 'one', entriesYaml: '', entries: {}, environment: [
    { name: 'SDK_ROOT', value: 'prefix:{dependency:文档.sdk}/sdk:{dependency:文档.sdk}' },
    { name: 'CREDENTIAL', value: '{dependency:文档.sdk}/{access-token}' }, { name: 'UPSTREAM', value: '{dependency:文档.sdk}/{upstream:shared}' },
  ] }
  const access = new MemberPluginAccess({ effective: () => managed, localSelection: () => local ? ['office'] : [] },
    { get: () => settings, list: () => ({}), save: () => {}, remove: () => {} },
    { accounts: { get: () => account }, records: { get: () => [{ packageName: 'office', source: 'selected', version: '1.0.0' }] } },
    { library: { list: () => [{ ...plugin, current: plugin, stage: 'available', published: true, removing, runtimeDependencies: ['文档.sdk'] }] }, ready: () => [version], runtimeRevision: 'rev' })
  const gateway = { url: 'https://platform.example', token: 'member-token' }, native = { username: 'member', installed: ['office'] }
  const first = access.resolve(managed, gateway, native)
  expect(first.environment.SDK_ROOT).toBe('prefix:/runtime/first/sdk:/runtime/first')
  expect(access.snapshot('member', ['office'])).toEqual(first.snapshot)
  const pinned = { '文档.sdk': version }; version = { ...version, id: 'second', mountedPath: '/runtime/second' }
  expect(access.snapshot('member', ['office'])).not.toEqual(first.snapshot)
  expect(access.resolve(managed, gateway, { ...native, dependencyVersions: pinned })).toEqual(first)
  managed = []
  expect(access.dependencyNames('member', ['office'])).toEqual(['文档.sdk'])
  const literals = access.resolve([], gateway, native)
  expect(literals.environment).toEqual({ SDK_ROOT: 'prefix:/runtime/second/sdk:/runtime/second' })
  expect(literals.entries).toEqual({}); expect(access.snapshot('member', ['office'])).toEqual(literals.snapshot)
  expect(access.dependencyNames('member', [])).toEqual([])
  local = true; expect(access.dependencyNames('member', ['office'])).toEqual([])
  local = false; removing = true; expect(access.dependencyNames('member', ['office'])).toEqual([])
  expect(access.resolve([], gateway, native).environment).toEqual({})
  removing = false; account.disabled = true; expect(access.dependencyNames('member', ['office'])).toEqual([])
})

it.each(['controlled', 'selected', 'preinstall', 'expert'] as const)('delivers declared dependencies through the actual %s eligibility policy and excludes local overrides and disabled accounts', async source => {
  const { MemberManagedPlugins } = await import('../src/use-cases/member-managed-plugins.js')
  const plugin = { packageName: 'office', version: '1.0.0', integrity: 'hash', artifact: '', runtimeRevision: 'rev', title: '', description: '', bundlePatch: '', dependencies: {} }
  const account = { username: 'member', spaceId: 'space', sessionEpoch: 0, disabled: false, admin: false, groupId: 'g', email: '', createdAt: 0, updatedAt: 0 }
  let local = false, removed = false, incompatible = false, delivered = true
  const library = { list: () => [{ ...plugin, current: plugin, stage: 'available' as const, published: false, removing: removed, incompatible, runtimeDependencies: ['sdk'] }], save: () => {}, remove: () => {} }
  const accounts = { get: () => account, listGroups: () => [{ id: 'g', name: 'Members', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }] }
  const managed = new MemberManagedPlugins(accounts, library, { get: () => source === 'controlled' ? ['office'] : [], set: () => {}, remove: () => {}, retainGroups: () => {} }, 'rev', undefined,
    { enabled: () => local }, { plugins: () => source === 'expert' ? [plugin] : [] })
  const access = new MemberPluginAccess(managed, { get: () => undefined, list: () => ({}), save: () => {}, remove: () => {} },
    { accounts, records: { get: () => delivered && (source === 'selected' || source === 'preinstall') ? [{ packageName: 'office', source, version: '1.0.0' }] : [] } },
    { library, ready: () => [], runtimeRevision: 'rev' })
  expect(access.dependencyNames('member', ['office'])).toEqual(['sdk'])
  if (source === 'selected' || source === 'preinstall') {
    expect(access.dependencyNames('member', [])).toEqual([])
    delivered = false; expect(access.dependencyNames('member', ['office'])).toEqual([]); delivered = true
  }
  local = true; expect(access.dependencyNames('member', ['office'])).toEqual([])
  local = false; removed = true; expect(access.dependencyNames('member', ['office'])).toEqual([])
  removed = false; incompatible = true; expect(access.dependencyNames('member', ['office'])).toEqual([])
  incompatible = false; account.disabled = true; expect(access.dependencyNames('member', ['office'])).toEqual([])
})
