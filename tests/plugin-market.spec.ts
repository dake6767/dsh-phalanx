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
  let row: LibraryPlugin = { source: { kind: 'npm' as const }, ...plugin, current: plugin, stage: 'available', published: true }
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
    integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
    artifact: 'artifacts/fixture',
    runtimeRevision: 'revision',
    title: 'Native',
    description: '',
    bundlePatch: '[]',
    dependencies: {},
  }
  let current = plugin,
    publication = true,
    generation = 0
  const library = {
    authorizationRevision: () => String(generation),
    list: async () => [
      {
        source: { kind: 'npm' as const },
        ...current,
        current,
        identities: {
          [plugin.version]: plugin.integrity,
          ['legacy:' + plugin.version]: plugin.integrity,
          [plugin.version + ':' + plugin.integrity]: plugin.integrity,
          [plugin.version + ':sha512-' + Buffer.alloc(64, 3).toString('base64')]: 'sha512-' + Buffer.alloc(64, 3).toString('base64'),
        },
        stage: 'available' as const,
        published: publication,
      },
    ],
    save: async () => {},
    remove: async () => {},
  }
  const instance = { userId: 'member', processId: 1, origin: 'http://localhost', launchUrl: 'http://localhost' },
    runtime = { ensure: async () => instance }
  let installed: import('../src/ports/plugin-market.js').InstalledMarketPlugin[] = [],
    credential = '',
    installCount = 0,
    failSave = false
  let finish!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => {
      entered = resolve
    }),
    completed = new Promise<void>(resolve => {
      finish = resolve
    })
  const manager = {
    list: async () => installed,
    verifyArchive: async () => true,
    install: async () => {
      installCount++
      entered()
      await completed
      installed = [{ packageName: 'native', version: '1.0.0', retainedArchive: true, archiveIntegrity: plugin.integrity, enabled: false }]
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
  let beforeDelivery: (() => Promise<void>) | undefined
  const records = {
    get: async () => {
      await beforeDelivery?.()
      return history
    },
    save: async (_space: string, row: import('../src/ports/plugin-installations.js').PluginInstallation) => {
      if (failSave) throw Error('Receipt store unavailable')
      history = [row]
    },
  }
  let adapted = false
  let setups = 0
  const jobs = new MemberNativePluginJobs(
    accounts,
    runtime,
    native,
    records,
    {
      describeDelivery: async () =>
        adapted ? { version: plugin.version, integrity: plugin.integrity, resourceOrigin: 'catalog', serviceOrigin: 'catalog' } : undefined,
    },
    {
      apply: async () => {
        setups++
        return []
      },
      cancelSpace: async () => {},
    },
  )
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
  const listMarket = () => market.list(account, origin, signal)
  expect(await market.install(account, 'native', origin, signal, 'request-1')).toMatchObject({ job: { status: 'running' } })
  await started
  expect((await market.list(account, origin, signal)).plugins[0]).toMatchObject({ status: 'install', job: { status: 'running' } })
  finish()
  await jobs.drain()
  expect((await market.list(account, origin, signal)).plugins[0]).toMatchObject({ status: 'installed', job: { status: 'succeeded' } })
  expect(selected).toEqual([])
  expect(history).toEqual([{ packageName: 'native', version: '1.0.0', source: 'selected', integrity: plugin.integrity }])
  current = { ...plugin, version: '2.0.0', integrity: 'sha512-' + Buffer.alloc(64, 2).toString('base64') }
  expect((await listMarket()).plugins[0]).toMatchObject({ status: 'installed', installedVersion: '1.0.0', update: { kind: 'version', version: '2.0.0' } })
  const choice = (await listMarket()).plugins[0]!.update!
  let count = 0,
    raceEntered!: () => void,
    release!: () => void
  const waiting = new Promise<void>(resolve => {
    raceEntered = resolve
  })
  const proceed = new Promise<void>(resolve => {
    release = resolve
  })
  beforeDelivery = async () => {
    if (++count === 2) {
      raceEntered()
      await proceed
    }
  }
  const accepting = market.update(account, 'native', origin, signal, 'update-while-unpublishing', choice.target)
  try {
    expect(await Promise.race([waiting.then(() => 'waiting'), accepting])).toBe('waiting')
    publication = false
    generation++
  } finally {
    release()
    beforeDelivery = undefined
  }
  await expect(accepting).rejects.toMatchObject({ code: 'plugin-update-changed' })
  expect((await listMarket()).plugins).toEqual([])
  publication = true
  generation++
  current = { ...current, version: '0.9.0' }
  expect((await listMarket()).plugins[0]?.update).toBeUndefined()
  current = { ...current, version: '1.0.0' }
  expect((await listMarket()).plugins[0]).toMatchObject({ update: { kind: 'content', version: '1.0.0' } })
  const recorded = history
  const actual = installed
  history = [{ packageName: 'native', version: '1.0.0', source: 'selected' }]
  expect((await listMarket()).plugins[0]?.update).toMatchObject({ kind: 'content' })
  installed = [{ ...installed[0]!, archiveIntegrity: 'sha512-' + Buffer.alloc(64, 3).toString('base64') }]
  expect((await listMarket()).plugins[0]).toMatchObject({ status: 'installed', installedVersion: '1.0.0' })
  expect((await listMarket()).plugins[0]?.update).toBeUndefined()
  installed = actual
  history = recorded
  current = plugin
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
  installed = []
  adapted = true
  selected = ['native']
  expect((await listMarket()).plugins[0]).toMatchObject({ status: 'selected', sharedCredential: true })
  await market.uninstall(account, 'native', origin, signal)
  expect(selected).toEqual([])
  expect((await listMarket()).plugins[0]).toMatchObject({ status: 'install' })
  expect((await listMarket()).plugins[0]?.sharedCredential).toBeUndefined()
  failSave = true
  expect(await market.install(account, 'native', origin, signal, 'install-adapted')).toMatchObject({ job: { action: 'install' } })
  await jobs.drain()
  expect((await listMarket()).plugins[0]).toMatchObject({ status: 'installed', job: { status: 'failed' }, retryReceipt: true })
  expect(history[0]?.resourceOrigin).toBeUndefined()
  expect(setups).toBe(0)
  failSave = false
  expect(await market.install(account, 'native', origin, signal, 'install-adapted')).toMatchObject({ job: { status: 'failed' } })
  publication = false
  await expect(market.install(account, 'native', origin, signal, 'retry-unpublished', true)).rejects.toThrow()
  publication = true
  const retainedArchive = installed
  installed = []
  await expect(market.install(account, 'native', origin, signal, 'retry-after-native-removal', true)).rejects.toThrow()
  expect(installCount).toBe(2)
  installed = retainedArchive
  installed = [{ ...installed[0]!, archiveIntegrity: 'sha512-replaced' }]
  expect((await listMarket()).plugins[0]?.retryReceipt).toBeUndefined()
  await expect(market.install(account, 'native', origin, signal, 'retry-replaced', true)).rejects.toThrow()
  installed = retainedArchive
  expect(await market.install(account, 'native', origin, signal, 'retry-adapted', true)).toMatchObject({ job: { action: 'install' } })
  await jobs.drain()
  expect((await listMarket()).plugins[0]).toMatchObject({ status: 'installed', job: { status: 'succeeded' } })
  expect((await listMarket()).plugins[0]?.retryReceipt).toBeUndefined()
  expect(installCount).toBe(2)
  expect(setups).toBe(1)
  expect(selected).toEqual([])
  expect(history[0]).toMatchObject({ resourceOrigin: 'catalog', serviceOrigin: 'catalog' })
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
    return { source: { kind: 'npm' as const }, ...current, current, stage: 'available', published: true }
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
