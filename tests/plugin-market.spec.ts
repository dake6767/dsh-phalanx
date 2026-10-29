import { expect, it } from 'vitest'
import { PluginMarket } from '../src/use-cases/plugin-market.js'
import type { LibraryPlugin } from '../src/domain/plugin-library.js'

it('records shared-credential selections without native installation, projects restart state and protects native and granted plugins', async () => {
  const admin = { username: 'admin', spaceId: 'a', sessionEpoch: 0, admin: true, groupId: 'admins', email: '', disabled: false, createdAt: 0, updatedAt: 0 }
  const member = { ...admin, username: 'member', spaceId: 'm', admin: false, groupId: 'members' }
  const plugin = {
    packageName: 'plugin',
    version: '1.0.0',
    integrity: 'hash',
    runtimeRevision: 'revision',
    artifact: 'artifacts/hash',
    title: 'Plugin',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  let row: LibraryPlugin = { ...plugin, current: plugin, stage: 'available', published: true }
  let installed: readonly { packageName: string; version: string; retainedArchive?: true }[] = [],
    granted: string[] = [],
    selected: string[] = [],
    snapshot: string[] = [],
    accessSnapshot: string[] = [],
    startupAccess: string[] = [],
    credential = '',
    removalFails = false
  const market = new PluginMarket(
    { get: async username => (username === 'admin' ? admin : member), list: async () => [admin, member] },
    {
      list: async () => [row],
      remove: async () => {},
      save: async next => {
        row = next
      },
    },
    { list: async () => installed },
    {
      ensure: async () => ({
        userId: 'member',
        origin: 'http://localhost',
        launchUrl: 'http://localhost',
        processId: 1,
        managedSnapshot: snapshot,
        pluginAccessSnapshot: startupAccess,
      }),
    },
    {
      get: async () => selected,
      set: async (_, names) => {
        selected = [...names]
      },
      members: async () => (selected.length ? ['m'] : []),
      removePackage: async () => {
        if (removalFails) throw Error('storage failed')
        selected = []
      },
      retainPackages: async () => {},
    },
    { granted: async () => granted, effective: async () => (granted.length || (row.published && selected.length) ? [row.current!] : []) },
    'revision',
    { snapshot: async () => accessSnapshot },
    { list: () => [{ name: 'upstream', baseUrl: 'https://example.test', credential, headers: [] }] },
  )
  const origin = new URL('http://localhost'),
    signal = new AbortController().signal
  const list = () => market.list(member, origin, signal)
  expect((await list()).plugins[0]?.status).toBe('install')
  installed = [{ packageName: 'plugin', version: '0.9.0' }]
  expect((await list()).plugins[0]?.status).toBe('native')
  await expect(market.install(member, 'plugin', origin, signal)).rejects.toThrow()
  credential = 'shared-fixture'
  installed = []
  expect(await market.install(member, 'plugin', origin, signal)).toEqual({ application: 'restart-required' })
  expect(selected).toEqual(['plugin'])
  expect((await list()).plugins[0]?.status).toBe('selected')
  expect((await list()).pending).toBe(true)
  snapshot = ['plugin@1.0.0:hash']
  expect((await list()).pending).toBe(false)
  installed = [{ packageName: 'plugin', version: '1.0.0', retainedArchive: true }]
  expect((await list()).plugins[0]).toMatchObject({ status: 'selected', sharedCredential: true })
  expect(await market.uninstall(member, 'plugin', origin, signal)).toEqual({ application: 'restart-required' })
  expect(selected).toEqual([])
  expect(installed).toHaveLength(1)
  expect((await list()).plugins[0]).toMatchObject({ status: 'installed' })
  installed = []
  await market.install(member, 'plugin', origin, signal)
  accessSnapshot = ['plugin:changed']
  expect((await list()).pending).toBe(true)
  startupAccess = accessSnapshot
  expect((await list()).pending).toBe(false)
  credential = 'new-upstream-key'
  expect((await list()).pending).toBe(false)
  credential = 'shared-fixture'
  granted = ['plugin']
  expect((await list()).plugins[0]?.status).toBe('managed')
  await expect(market.uninstall(member, 'plugin', origin, signal)).rejects.toThrow()
  granted = []
  await market.uninstall(member, 'plugin', origin, signal)
  expect(selected).toEqual([])
  expect((await list()).pending).toBe(true)
  await market.install(member, 'plugin', origin, signal)
  await expect(market.publish(admin, 'plugin', false)).rejects.toThrow()
  await market.publish(admin, 'plugin', false, { confirmed: true, selectedMembers: 1 })
  expect(selected).toEqual([])
  expect((await list()).plugins).toEqual([])
  expect((await list()).pending).toBe(true)
  await expect(market.publish(member, 'plugin', true)).rejects.toThrow()
  await market.publish(admin, 'plugin', true, { confirmed: true })
  await market.install(member, 'plugin', origin, signal)
  removalFails = true
  await expect(market.publish(admin, 'plugin', false, { confirmed: true, selectedMembers: 1 })).rejects.toThrow()
  expect(row.published).toBe(false)
  await expect(market.publish(admin, 'plugin', true)).rejects.toThrow()
  expect(row.published).toBe(false)
  removalFails = false
  await market.publish(admin, 'plugin', true, { confirmed: true })
  expect(selected).toEqual([])
  expect((await list()).plugins[0]?.status).toBe('install')
  credential = 'key'
  await expect(market.publish(admin, 'plugin', true)).rejects.toThrow(expect.objectContaining({ code: 'plugin-publication-credential-confirmation' }))
  await market.publish(admin, 'plugin', true, { confirmed: true })
})

it('uses actual native inventory for market actions without treating delivery history as current ownership', async () => {
  const { MemberNativePlugins } = await import('../src/use-cases/member-native-plugins.js')
  const { MemberNativePluginJobs } = await import('../src/use-cases/member-native-plugin-jobs.js')
  const { NativePluginDownloads } = await import('../src/use-cases/native-plugin-downloads.js')
  const account = { username: 'member', spaceId: 'space', sessionEpoch: 0, admin: false, disabled: false, email: '', groupId: 'g', createdAt: 0, updatedAt: 0 }
  const accounts = { get: async () => account, list: async () => [account] }
  const plugin = {
    packageName: 'native',
    version: '1.0.0',
    integrity: 'sha512-fixture',
    artifact: 'artifacts/fixture',
    runtimeRevision: 'revision',
    title: 'Native',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  const library = {
    list: async () => [{ ...plugin, current: plugin, stage: 'available' as const, published: true }],
    save: async () => {},
    remove: async () => {},
  }
  const instance = { userId: 'member', processId: 1, origin: 'http://localhost', launchUrl: 'http://localhost' },
    runtime = { ensure: async () => instance }
  let installed: { packageName: string; version: string; retainedArchive?: true }[] = [],
    credential = ''
  let finish!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => {
      entered = resolve
    }),
    completed = new Promise<void>(resolve => {
      finish = resolve
    })
  const manager = {
    list: async () => installed,
    install: async () => {
      entered()
      await completed
      installed = [{ packageName: 'native', version: '1.0.0', retainedArchive: true }]
      return 'applied' as const
    },
    remove: async () => {
      installed = []
      return 'applied' as const
    },
  }
  const downloads = new NativePluginDownloads(accounts, library, { issue: () => 'signed', read: () => undefined }, { now: () => 0 }, 'revision')
  const native = new MemberNativePlugins(accounts, downloads, manager, { current: () => ({ npm: 'https://registry.npmjs.org' }) })
  let history: readonly import('../src/ports/plugin-installations.js').PluginInstallation[] = []
  const records = {
    get: async () => history,
    save: async (_space: string, row: import('../src/ports/plugin-installations.js').PluginInstallation) => {
      history = [row]
    },
  }
  const jobs = new MemberNativePluginJobs(accounts, runtime, native, records)
  let selected: readonly string[] = []
  const selections = {
    get: async () => selected,
    set: async (_space: string, rows: readonly string[]) => {
      selected = rows
    },
    members: async () => [],
    removePackage: async () => {},
    retainPackages: async () => {},
  }
  const market = new PluginMarket(
    accounts,
    library,
    manager,
    runtime,
    selections,
    { granted: async () => [], effective: async () => [] },
    'revision',
    undefined,
    { list: () => [{ name: 'shared', baseUrl: 'https://example.test', headers: [], credential }] },
    undefined,
    jobs,
  )
  const origin = new URL('http://localhost'),
    signal = new AbortController().signal
  expect(await market.install(account, 'native', origin, signal, 'request-1')).toMatchObject({ job: { status: 'running' } })
  await started
  expect((await market.list(account, origin, signal)).plugins[0]).toMatchObject({ status: 'install', job: { status: 'running' } })
  finish()
  await jobs.drain()
  expect((await market.list(account, origin, signal)).plugins[0]).toMatchObject({ status: 'installed', job: { status: 'succeeded' } })
  expect(selected).toEqual([])
  expect(history).toEqual([{ packageName: 'native', version: '1.0.0', source: 'selected' }])
  credential = 'shared-fixture' // A preinstalled native copy still has no shared key.
  expect((await market.list(account, origin, signal)).plugins[0]?.sharedCredential).not.toBe(true)
  expect(await market.uninstall(account, 'native', origin, signal, 'remove-1')).toMatchObject({ job: { action: 'uninstall' } })
  await jobs.drain()
  expect(installed).toEqual([])
  expect(history).toHaveLength(1)
  installed = [{ packageName: 'native', version: '2.0.0' }]
  expect((await market.list(account, origin, signal)).plugins[0]).toMatchObject({ status: 'native' })
  await expect(market.install(account, 'native', origin, signal, 'request-2')).rejects.toThrow()
  await expect(market.uninstall(account, 'native', origin, signal, 'remove-2')).rejects.toThrow()
  expect(installed).toEqual([{ packageName: 'native', version: '2.0.0' }])
  expect(history).toHaveLength(1)
  await jobs.stop()
})

it('retains both plugins when two shared-credential selections arrive together', async () => {
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
    return { ...current, current, stage: 'available', published: true }
  })
  let selected: readonly string[] = []
  const market = new PluginMarket(
    { get: async () => member, list: async () => [member] },
    { list: async () => rows, save: async () => {}, remove: async () => {} },
    { list: async () => [] },
    { ensure: async () => ({ userId: 'member', origin: 'http://localhost', launchUrl: 'http://localhost', processId: 1, managedSnapshot: [] }) },
    {
      get: async () => selected,
      set: async (_space, names) => {
        selected = names
      },
      members: async () => [],
      removePackage: async () => {},
      retainPackages: async () => {},
    },
    { effective: async () => [], granted: async () => [] },
    'revision',
    undefined,
    { list: () => [{ name: 'upstream', baseUrl: 'https://example.test', credential: 'fixture', headers: [] }] },
  )
  await Promise.all(['one', 'two'].map(name => market.install(member, name, new URL('http://localhost'), new AbortController().signal)))
  expect([...selected].sort()).toEqual(['one', 'two'])
})
