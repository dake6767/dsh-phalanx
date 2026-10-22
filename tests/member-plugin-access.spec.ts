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
