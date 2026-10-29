import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { MemberPluginAccess } from '../src/use-cases/member-plugin-access.js'
import { mergePluginConfig } from '../src/dsh/managed-plugin-access.js'

it('resolves only effective platform plugins and keeps access snapshots independent from upstream changes', async () => {
  const plugin = {
    packageName: '@example/plugin',
    version: '1.0.0',
    integrity: 'hash',
    artifact: '',
    runtimeRevision: 'rev',
    title: '',
    description: '',
    bundlePatch: '',
    dependencies: {},
  }
  let effective = [plugin]
  const settings = {
    environment: [
      { name: 'PLUGIN_KEY', value: '{access-token}' },
      { name: 'PLUGIN_URL', value: '{upstream:search}/v1' },
    ],
    entriesYaml: '',
    entries: { main: { apiKey: '{access-token}', endpoint: '{upstream:search}', tools: { a: true }, list: ['new'] } },
    revision: 'saved-1',
  }
  const access = new MemberPluginAccess(
    { effective: async () => effective },
    { get: name => (name === plugin.packageName ? settings : undefined), list: () => ({}), save: async () => {}, remove: async () => {} },
  )
  const input = { url: 'http://127.0.0.1:1234/models', token: 'member-token' }
  const result = await access.resolve(effective, input)
  expect(result.environment).toMatchObject({ PLUGIN_KEY: 'member-token', PLUGIN_URL: 'http://127.0.0.1:1234/plugins/%40example%2Fplugin/search/v1' })
  const evaluate = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(evaluate)
    if (value && typeof value === 'object')
      return '__jsExpr' in value
        ? runInNewContext(String(value.__jsExpr), { process: { env: result.environment } })
        : Object.fromEntries(Object.entries(value).map(([key, row]) => [key, evaluate(row)]))
    return value
  }
  expect(evaluate(result.entries[plugin.packageName]?.main)).toMatchObject({
    apiKey: 'member-token',
    endpoint: 'http://127.0.0.1:1234/plugins/%40example%2Fplugin/search',
  })
  expect(
    mergePluginConfig(
      { tools: { a: false, b: true }, list: ['old'], preserved: 1 },
      evaluate(result.entries[plugin.packageName]!.main!) as Record<string, unknown>,
    ),
  ).toMatchObject({ tools: { a: true, b: true }, list: ['new'], preserved: 1 })
  expect(await access.snapshot('member')).toEqual(['@example/plugin:saved-1'])
  effective = [] // revoked, unpublished or removed; native installations are never inputs
  expect(await access.snapshot('member')).toEqual([])
  expect(await access.resolve(effective, input)).toEqual({ environment: {}, entries: {}, snapshot: [] })
  expect((await access.resolve([{ ...plugin, packageName: 'unconfigured' }], input)).snapshot).toEqual([])
})

it('projects the real grant-selection union once and drops access when publication or membership ends', async () => {
  const { MemberManagedPlugins } = await import('../src/use-cases/member-managed-plugins.js')
  const plugin = {
    packageName: 'plugin',
    version: '1.0.0',
    integrity: 'hash',
    artifact: '',
    runtimeRevision: 'rev',
    title: '',
    description: '',
    bundlePatch: '',
    dependencies: {},
  }
  let grants: string[] = [],
    selected: string[] = [],
    published = true,
    removed = false
  const managed = new MemberManagedPlugins(
    {
      get: async () => ({
        username: 'member',
        spaceId: 'space',
        sessionEpoch: 0,
        disabled: false,
        admin: false,
        groupId: 'g',
        email: '',
        createdAt: 0,
        updatedAt: 0,
      }),
      listGroups: async () => [{ id: 'g', name: 'Members', kind: 'ordinary', isDefault: true, memberCount: 1 }],
    },
    { list: async () => (removed ? [] : [{ ...plugin, current: plugin, published, stage: 'available' }]), save: async () => {}, remove: async () => {} },
    { get: async () => grants, set: async () => {}, remove: async () => {}, retainGroups: async () => {} },
    'rev',
    { get: async () => selected, retainPackages: async () => {} },
    undefined,
    undefined,
    { list: () => [{ name: 'shared', baseUrl: 'https://example.test', credential: 'fixture-key', headers: [] }] },
  )
  const access = new MemberPluginAccess(managed, {
    get: () => ({ revision: 'configured', environment: [{ name: 'PLUGIN_KEY', value: '{access-token}' }], entriesYaml: '', entries: {} }),
    list: () => ({}),
    save: async () => {},
    remove: async () => {},
  })
  expect(await access.snapshot('member')).toEqual([]) // Native member bundles never enter the effective set.
  grants = ['plugin']
  expect(await access.snapshot('member')).toEqual(['plugin:configured'])
  selected = ['plugin']
  expect(await access.snapshot('member')).toEqual(['plugin:configured'])
  grants = []
  expect(await access.snapshot('member')).toEqual(['plugin:configured'])
  published = false
  expect(await access.snapshot('member')).toEqual([])
  grants = ['plugin']
  expect(await access.snapshot('member')).toEqual(['plugin:configured'])
  removed = true
  expect(await access.snapshot('member')).toEqual([])
})

it('projects only literal startup environment for successful native deliveries still present in the real inventory', async () => {
  const account = { username: 'member', spaceId: 'space', sessionEpoch: 0, disabled: false, admin: false, groupId: 'g', email: '', createdAt: 0, updatedAt: 0 }
  let delivered = false,
    localCopy = false,
    source: 'selected' | 'preinstall' = 'selected'
  let settings = {
    revision: 'one',
    entriesYaml: '',
    entries: { main: { forbidden: 'entry-only' } },
    environment: [
      { name: 'WELCOME', value: 'hello' },
      { name: 'HOME', value: '/foreign' },
      { name: 'SHARED_TOKEN', value: '{access-token}' },
      { name: 'SHARED_URL', value: '{upstream:shared}/v1' },
    ],
  }
  const store = { get: () => settings, list: () => ({}), save: async () => {}, remove: async () => {} }
  const access = new MemberPluginAccess({ effective: async () => [], localSelection: async () => (localCopy ? ['plugin'] : []) }, store, {
    accounts: { get: async () => account },
    records: { get: async () => (delivered ? [{ packageName: 'plugin', source, version: '1.0.0' }] : []) },
  })
  const gateway = { url: 'https://platform.example', token: 'member-token' },
    native = { username: 'member', installed: ['plugin'] }
  expect(await access.resolve([], gateway, native)).toEqual({ environment: {}, entries: {}, snapshot: [] })
  delivered = true
  const result = await access.resolve([], gateway, native)
  expect(result.environment).toEqual({ WELCOME: 'hello' })
  expect(result.entries).toEqual({})
  expect(result.snapshot).toHaveLength(1)
  expect(await access.snapshot('member', ['plugin'])).toEqual(result.snapshot)
  source = 'preinstall'
  expect(await access.resolve([], gateway, native)).toEqual(result)
  settings = {
    ...settings,
    revision: 'two',
    entries: { main: { forbidden: 'changed-entry' } },
    environment: [...settings.environment.filter(row => row.name !== 'SHARED_TOKEN'), { name: 'SHARED_TOKEN', value: 'prefix-{access-token}' }],
  }
  expect(await access.snapshot('member', ['plugin'])).toEqual(result.snapshot)
  expect(await access.resolve([], gateway, { ...native, installed: [] })).toEqual({ environment: {}, entries: {}, snapshot: [] })
  expect(await access.snapshot('member', [])).toEqual([])
  settings = { ...settings, environment: [{ name: 'WELCOME', value: 'updated' }] }
  expect(await access.snapshot('member', ['plugin'])).not.toEqual(result.snapshot)
  localCopy = true
  expect(await access.resolve([], gateway, native)).toEqual({ environment: {}, entries: {}, snapshot: [] })
  localCopy = false
  account.disabled = true
  expect(await access.resolve([], gateway, native)).toEqual({ environment: {}, entries: {}, snapshot: [] })
})

it('binds managed and native dependency templates to one declared ready generation and filters credential rows as a whole', async () => {
  const plugin = {
    packageName: 'office',
    version: '1.0.0',
    integrity: 'hash',
    artifact: '',
    runtimeRevision: 'rev',
    title: '',
    description: '',
    bundlePatch: '',
    dependencies: {},
  }
  const account = { username: 'member', spaceId: 'space', sessionEpoch: 0, disabled: false, admin: false, groupId: 'g', email: '', createdAt: 0, updatedAt: 0 }
  let managed = [plugin],
    version = {
      id: 'first',
      mountedPath: '/runtime/first',
      identity: 'first',
      directory: '/host/first',
      pathDirectories: [],
      bytes: 1,
      isolated: true,
      checks: [],
      log: '',
      commands: [],
      commandPaths: {},
    },
    removing = false,
    local = false
  const settings = {
    revision: 'one',
    entriesYaml: '',
    entries: {},
    environment: [
      { name: 'SDK_ROOT', value: 'prefix:{dependency:文档.sdk}/sdk:{dependency:文档.sdk}' },
      { name: 'CREDENTIAL', value: '{dependency:文档.sdk}/{access-token}' },
      { name: 'UPSTREAM', value: '{dependency:文档.sdk}/{upstream:shared}' },
    ],
  }
  const access = new MemberPluginAccess(
    { effective: async () => managed, localSelection: async () => (local ? ['office'] : []) },
    { get: () => settings, list: () => ({}), save: async () => {}, remove: async () => {} },
    { accounts: { get: async () => account }, records: { get: async () => [{ packageName: 'office', source: 'selected', version: '1.0.0' }] } },
    {
      library: { list: async () => [{ ...plugin, current: plugin, stage: 'available', published: true, removing, runtimeDependencies: ['文档.sdk'] }] },
      ready: () => [version],
      runtimeRevision: 'rev',
    },
  )
  const gateway = { url: 'https://platform.example', token: 'member-token' },
    native = { username: 'member', installed: ['office'] }
  const first = await access.resolve(managed, gateway, native)
  expect(first.environment.SDK_ROOT).toBe('prefix:/runtime/first/sdk:/runtime/first')
  expect(await access.snapshot('member', ['office'])).toEqual(first.snapshot)
  const pinned = { '文档.sdk': version }
  version = { ...version, id: 'second', mountedPath: '/runtime/second' }
  expect(await access.snapshot('member', ['office'])).not.toEqual(first.snapshot)
  expect(await access.resolve(managed, gateway, { ...native, dependencyVersions: pinned })).toEqual(first)
  managed = []
  expect(await access.dependencyNames('member', ['office'])).toEqual(['文档.sdk'])
  const literals = await access.resolve([], gateway, native)
  expect(literals.environment).toEqual({ SDK_ROOT: 'prefix:/runtime/second/sdk:/runtime/second' })
  expect(literals.entries).toEqual({})
  expect(await access.snapshot('member', ['office'])).toEqual(literals.snapshot)
  expect(await access.dependencyNames('member', [])).toEqual([])
  local = true
  expect(await access.dependencyNames('member', ['office'])).toEqual([])
  local = false
  removing = true
  expect(await access.dependencyNames('member', ['office'])).toEqual([])
  expect((await access.resolve([], gateway, native)).environment).toEqual({})
  removing = false
  account.disabled = true
  expect(await access.dependencyNames('member', ['office'])).toEqual([])
})

it.each(['controlled', 'selected', 'preinstall', 'expert'] as const)(
  'delivers declared dependencies through the actual %s eligibility policy and excludes local overrides and disabled accounts',
  async source => {
    const { MemberManagedPlugins } = await import('../src/use-cases/member-managed-plugins.js')
    const plugin = {
      packageName: 'office',
      version: '1.0.0',
      integrity: 'hash',
      artifact: '',
      runtimeRevision: 'rev',
      title: '',
      description: '',
      bundlePatch: '',
      dependencies: {},
    }
    const account = {
      username: 'member',
      spaceId: 'space',
      sessionEpoch: 0,
      disabled: false,
      admin: false,
      groupId: 'g',
      email: '',
      createdAt: 0,
      updatedAt: 0,
    }
    let local = false,
      removed = false,
      incompatible = false,
      delivered = true
    const library = {
      list: async () => [
        { ...plugin, current: plugin, stage: 'available' as const, published: false, removing: removed, incompatible, runtimeDependencies: ['sdk'] },
      ],
      save: async () => {},
      remove: async () => {},
    }
    const accounts = {
      get: async () => account,
      listGroups: async () => [{ id: 'g', name: 'Members', kind: 'ordinary' as const, isDefault: true, memberCount: 1 }],
    }
    const managed = new MemberManagedPlugins(
      accounts,
      library,
      { get: async () => (source === 'controlled' ? ['office'] : []), set: async () => {}, remove: async () => {}, retainGroups: async () => {} },
      'rev',
      undefined,
      { enabled: async () => local },
      { plugins: async () => (source === 'expert' ? [plugin] : []) },
    )
    const access = new MemberPluginAccess(
      managed,
      { get: () => undefined, list: () => ({}), save: async () => {}, remove: async () => {} },
      {
        accounts,
        records: {
          get: async () => (delivered && (source === 'selected' || source === 'preinstall') ? [{ packageName: 'office', source, version: '1.0.0' }] : []),
        },
      },
      { library, ready: () => [], runtimeRevision: 'rev' },
    )
    expect(await access.dependencyNames('member', ['office'])).toEqual(['sdk'])
    if (source === 'selected' || source === 'preinstall') {
      expect(await access.dependencyNames('member', [])).toEqual([])
      delivered = false
      expect(await access.dependencyNames('member', ['office'])).toEqual([])
      delivered = true
    }
    local = true
    expect(await access.dependencyNames('member', ['office'])).toEqual([])
    local = false
    removed = true
    expect(await access.dependencyNames('member', ['office'])).toEqual([])
    removed = false
    incompatible = true
    expect(await access.dependencyNames('member', ['office'])).toEqual([])
    incompatible = false
    account.disabled = true
    expect(await access.dependencyNames('member', ['office'])).toEqual([])
  },
)
