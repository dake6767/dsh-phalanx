import { asyncMcpFacts } from './fixtures/async-mcp-facts.js'
import { mcpWriteInput } from '../src/domain/mcp-service.js'
import { expect, it, vi } from 'vitest'
import { PlatformDatabaseError } from '../src/domain/platform-database.js'
import { McpConnectionTest } from '../src/use-cases/mcp-connection-test.js'
import { McpCatalogImports } from '../src/use-cases/mcp-catalog-imports.js'
import { McpSharedRuntime } from '../src/use-cases/mcp-shared-runtime.js'
import { ExecutionControl } from '../src/use-cases/execution-control.js'
import { DEFAULT_EXECUTION_LIMITS } from '../src/domain/execution-control.js'
import { McpServices } from '../src/use-cases/mcp-services.js'
import type { McpState } from '../src/domain/mcp-service.js'

function fixture(synchronize: () => Promise<void> = async () => {}, runtime?: import('../src/ports/mcp-services.js').McpRuntimePort) {
  let state: McpState = { services: [], grants: {} }
  const accounts = ['admin', 'member'].map(username => ({
    username,
    spaceId: username,
    admin: username === 'admin',
    groupId: username === 'admin' ? 'admins' : 'members',
    disabled: false,
    sessionEpoch: 0,
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }))
  const groups = [
    { id: 'admins', name: 'Admins', kind: 'admin' as const, isDefault: false, memberCount: 1 },
    { id: 'members', name: 'Members', kind: 'ordinary' as const, isDefault: true, memberCount: 1 },
  ]
  const store = {
    read: () => structuredClone(state),
    write: async (next: McpState) => {
      state = structuredClone(next)
    },
  }
  const create = () =>
    new McpServices(
      { get: async name => accounts.find(row => row.username === name), list: async () => accounts, listGroups: async () => groups },
      asyncMcpFacts(store),
      { synchronize },
      runtime,
    )
  return { service: create(), create, actor: { username: 'admin', spaceId: 'admin', sessionEpoch: 0 }, accounts }
}
const input = { presetId: 'amap', name: 'p-map', credential: 'fixture-map-key', requestId: 'test-import-request-0001' }
it('imports a private preset once across refresh and restart, allows explicit copies and keeps deleted requests retired', async () => {
  const { service, create, actor } = fixture()
  await service.importCatalog(actor, input)
  const restarted = create()
  await restarted.importCatalog(actor, input)
  expect(await restarted.list(actor)).toHaveLength(1)
  expect((await restarted.list(actor))[0]).toMatchObject({
    name: 'p-map',
    url: 'https://mcp.amap.com/mcp',
    catalog: { id: 'amap', version: '1', status: 'testing' },
    query: [{ name: 'key', configured: true, last4: 'ial}' }],
    credentialConfigured: true,
    published: false,
  })
  expect(JSON.stringify(await restarted.list(actor))).not.toContain('fixture-map-key')
  expect(await restarted.effective('admin')).toEqual([])
  expect(await restarted.effective('member')).toEqual([])
  await expect(restarted.publish(actor, 'p-map', true)).rejects.toThrow()
  await restarted.importCatalog(actor, { ...input, name: 'p-map-copy', requestId: 'test-import-request-0002' })
  expect((await restarted.catalog(actor))[0]).toMatchObject({ id: 'amap', imported: 2 })
  await restarted.remove(actor, 'p-map')
  await expect(restarted.importCatalog(actor, input)).rejects.toThrow()
  expect((await restarted.list(actor)).map(row => row.name)).toEqual(['p-map-copy'])
})
it('locks preset configuration at the service boundary without binding manually named services', async () => {
  const { service, actor } = fixture()
  await service.importCatalog(actor, input)
  const saved = (await service.list(actor))[0]!
  for (const changed of [
    { url: 'https://other.example.test' },
    { run: { location: 'shared' as const, command: 'node', args: [], env: [], prepareCommand: '' } },
    { query: [{ name: 'key', value: 'real-key' }] },
    { headers: [{ name: 'Authorization', value: 'Bearer {credential}' }] },
    { description: 'Changed' },
    { credentials: { extra: 'secret' } },
  ]) {
    await expect(service.save(actor, { ...mcpWriteInput(saved), ...changed })).rejects.toThrow()
  }
  await service.grant(actor, 'members', ['p-map'])
  expect(await service.effective('member')).toEqual([])
  await service.recordTest(actor, 'p-map', (await service.diagnostic('admin', 'p-map')).generation, [{ name: 'maps_weather', inputSchema: {} }])
  expect(await service.effective('member')).toHaveLength(1)
  await service.save(
    actor,
    { ...mcpWriteInput((await service.list(actor))[0]!), name: 'p-renamed', credential: 'rotated-key', disabledTools: ['maps_weather'] },
    false,
    'p-map',
  )
  expect((await service.list(actor))[0]).toMatchObject({
    name: 'p-renamed',
    catalog: { id: 'amap', status: 'failed' },
    testStatus: 'untested',
    disabledTools: ['maps_weather'],
  })
  expect(await service.effective('member')).toEqual([])
  await service.importCatalog(actor, input)
  expect(await service.list(actor)).toHaveLength(1)
  await service.save(actor, { name: 'p-amap', description: 'Manual', url: 'https://custom.example.test' })
  await service.save(actor, { name: 'p-amap', description: 'Manual', url: 'https://changed.example.test' })
  expect((await service.list(actor)).find(row => row.name === 'p-amap')?.catalog).toBeUndefined()
})

it('automatically tests imports, exposes durable progress and retries a failure without another service', async () => {
  const { service, create, actor } = fixture()
  let release!: () => void,
    entered!: () => void,
    failing = true
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    started = new Promise<void>(resolve => {
      entered = resolve
    })
  const imports = new McpCatalogImports(
    service,
    new McpConnectionTest(service, {
      probe: async () => {
        entered()
        await gate
        if (failing) throw Error('secret upstream detail')
        return [{ name: 'maps_weather', inputSchema: {} }]
      },
    }),
  )
  await imports.import(actor, input)
  await started
  expect((await create().list(actor))[0]?.catalog?.status).toBe('testing')
  release()
  await imports.drain()
  expect((await service.list(actor))[0]).toMatchObject({ catalog: { status: 'failed' }, testStatus: 'failed' })
  await expect(service.publish(actor, input.name, true)).rejects.toThrow()
  failing = false
  await imports.retry(actor, input.name)
  await imports.drain()
  expect(await service.list(actor)).toHaveLength(1)
  expect((await service.list(actor))[0]).toMatchObject({ catalog: { status: 'ready' }, testStatus: 'passed' })
  expect(await service.effective('admin')).toEqual([])
})
it('invalidates in-flight results after rotation, deletion and administrator revocation and recovers interruption', async () => {
  const { service, create, actor, accounts } = fixture()
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => {
      release = resolve
    }),
    started = new Promise<void>(resolve => {
      entered = resolve
    })
  const imports = new McpCatalogImports(
    service,
    new McpConnectionTest(service, {
      probe: async () => {
        entered()
        await gate
        return [{ name: 'stale', inputSchema: {} }]
      },
    }),
  )
  await imports.import(actor, input)
  await started
  await service.save(actor, { ...mcpWriteInput((await service.list(actor))[0]!), credential: 'new-key' })
  release()
  await imports.drain()
  expect((await service.list(actor))[0]).toMatchObject({ catalog: { status: 'failed' }, testStatus: 'untested', tools: [] })
  await service.beginCatalogTest(actor, input.name)
  const restarted = create()
  await restarted.interruptCatalogTests()
  expect((await restarted.list(actor))[0]?.catalog?.status).toBe('failed')
  await service.remove(actor, input.name)
  await imports.retry(actor, input.name).catch(() => undefined)
  expect(await service.list(actor)).toEqual([])
  await service.importCatalog(actor, { ...input, requestId: 'another-import-request' })
  accounts[0]!.admin = false
  await expect(imports.retry(actor, input.name)).rejects.toThrow()
  accounts[0]!.admin = true
  expect((await service.list(actor))[0]?.catalog?.status).toBe('testing')
})

it('makes a persisted import retryable when projection fails before its probe can start', async () => {
  let failing = true
  const { service, actor } = fixture(async () => {
    if (failing) throw Error('projection unavailable')
  })
  const imports = new McpCatalogImports(service, new McpConnectionTest(service, { probe: async () => [{ name: 'weather', inputSchema: {} }] }))
  await expect(imports.import(actor, input)).rejects.toThrow()
  expect((await service.list(actor))[0]?.catalog?.status).toBe('failed')
  failing = false
  await imports.retry(actor, input.name)
  await imports.drain()
  expect((await service.list(actor))[0]?.catalog?.status).toBe('ready')
})
it('makes a persisted import retryable when its administrator is revoked during projection', async () => {
  let revoke = () => {}
  const { service, actor, accounts } = fixture(async () => {
    revoke()
  })
  revoke = () => {
    accounts[0]!.admin = false
  }
  const imports = new McpCatalogImports(service, new McpConnectionTest(service, { probe: async () => [{ name: 'weather', inputSchema: {} }] }))
  await imports.import(actor, input)
  await imports.drain()
  accounts[0]!.admin = true
  expect((await service.list(actor))[0]?.catalog?.status).toBe('failed')
})

it('imports 12306 without a key and waits for prepared dependencies before automatic discovery', async () => {
  let stage: 'preparing' | 'ready' | 'failed' = 'preparing',
    probed = false
  const runtime = {
    ready: () => (stage === 'ready' ? { directory: '/prepared' } : undefined),
    view: () => ({ stage, updatedAt: 1, log: '' }),
    changed: async () => {},
    restart: () => {},
  }
  const { service, actor } = fixture(undefined, runtime)
  const imports = new McpCatalogImports(
    service,
    new McpConnectionTest(service, {
      probe: async () => {
        probed = true
        return [{ name: 'get-tickets', inputSchema: {} }]
      },
    }),
  )
  await imports.import(actor, { presetId: '12306', name: 'p-trains', credential: '', requestId: 'train-import-request-01' })
  expect((await service.list(actor))[0]).toMatchObject({
    catalog: { id: '12306', status: 'preparing' },
    credentialConfigured: false,
    run: { location: 'shared', command: 'node' },
  })
  expect(probed).toBe(false)
  stage = 'ready'
  await service.recover()
  await imports.drain()
  expect((await service.list(actor))[0]).toMatchObject({ catalog: { status: 'ready' }, testStatus: 'passed' })
  expect(probed).toBe(true)
  await imports.stop()
})
it('retains preparation failures for retry and settles waiting imports on removal and shutdown', async () => {
  let stage: 'preparing' | 'ready' | 'failed' = 'preparing'
  const runtime = {
    ready: () => (stage === 'ready' ? { directory: '/prepared' } : undefined),
    view: () => ({ stage, updatedAt: 1, log: '' }),
    changed: async () => {},
    restart: () => {
      stage = 'preparing'
    },
  }
  const { service, actor } = fixture(undefined, runtime)
  const imports = new McpCatalogImports(service, new McpConnectionTest(service, { probe: async () => [{ name: 'get-tickets', inputSchema: {} }] }))
  const train = { presetId: '12306', name: 'p-trains', credential: '', requestId: 'train-import-request-02' }
  await imports.import(actor, train)
  stage = 'failed'
  await service.recover()
  await imports.drain()
  expect((await service.list(actor))[0]?.catalog?.status).toBe('failed')
  await expect(service.publish(actor, train.name, true)).rejects.toThrow()
  await imports.retry(actor, train.name)
  expect((await service.list(actor))[0]?.catalog?.status).toBe('preparing')
  stage = 'ready'
  await service.recover()
  await imports.drain()
  expect((await service.list(actor))[0]?.catalog?.status).toBe('ready')
  stage = 'preparing'
  await imports.import(actor, { ...train, name: 'p-other', requestId: 'train-import-request-03' })
  await service.remove(actor, 'p-other')
  await imports.drain()
  expect(await service.list(actor)).toHaveLength(1)
  await imports.import(actor, { ...train, name: 'p-stop', requestId: 'train-import-request-04' })
  await imports.stop()
  expect((await service.list(actor)).find(row => row.name === 'p-stop')?.catalog?.status).toBe('failed')
})
it('does not strand a preparation waiter when its completion projection fails', async () => {
  let ready = false,
    broken = false
  const runtime = {
    ready: () => (ready ? { directory: '/prepared' } : undefined),
    view: () => ({ stage: ready ? ('ready' as const) : ('preparing' as const), updatedAt: 1, log: '' }),
    changed: async () => {},
    restart: () => {},
  }
  const { service, actor } = fixture(async () => {
    if (broken) throw Error('projection failed')
  }, runtime)
  const imports = new McpCatalogImports(service, new McpConnectionTest(service, { probe: async () => [{ name: 'get-tickets', inputSchema: {} }] }))
  try {
    await imports.import(actor, { presetId: '12306', name: 'p-trains', credential: '', requestId: 'train-import-request-05' })
    ready = true
    broken = true
    await expect(service.recover()).rejects.toThrow()
    await expect.poll(async () => (await service.list(actor))[0]?.catalog?.status, { timeout: 500 }).toBe('failed')
  } finally {
    broken = false
    await imports.stop()
  }
})

it('keeps two adopted train services independently authorized and in distinct sessions for one member', async () => {
  const { service, actor } = fixture(undefined, {
    ready: row => ({ directory: '/prepared/' + row.name }),
    view: () => ({ stage: 'ready', updatedAt: 1, log: '' }),
    changed: async () => {},
    restart() {},
  })
  const imports = new McpCatalogImports(service, new McpConnectionTest(service, { probe: async () => [{ name: 'get-tickets', inputSchema: {} }] }))
  const live = new Set<string>()
  let count = 0
  const control = new ExecutionControl(
    { get: async () => DEFAULT_EXECUTION_LIMITS, async save() {} },
    { start: () => ({ signal: new AbortController().signal, dispose() {} }) },
  )
  const shared = new McpSharedRuntime(
    {
      isolated: true,
      recover: async () => {},
      start: async (row, _active, signal) => {
        live.add(row.name)
        return {
          target: { name: row.name, baseUrl: `http://127.0.0.1:${4000 + ++count}/mcp`, credential: '', headers: [] },
          closed: new Promise<number>(resolve =>
            signal.addEventListener(
              'abort',
              () => {
                live.delete(row.name)
                resolve(0)
              },
              { once: true },
            ),
          ),
        }
      },
    },
    control,
    { now: () => 0 },
    { start: () => () => {} },
    async (username, name, diagnostic) => await service.runtimeService(username, name, diagnostic),
  )
  try {
    for (const name of ['p-train-one', 'p-train-two'])
      await imports.import(actor, { presetId: '12306', name, credential: '', requestId: 'independent-import-' + name })
    await imports.drain()
    await service.grant(actor, 'members', ['p-train-one'])
    const one = await service.diagnostic('admin', 'p-train-one'),
      two = await service.diagnostic('admin', 'p-train-two')
    const first = await shared.connect('member', one, false)
    await expect(shared.connect('member', two, false)).rejects.toMatchObject({ code: 'not-ready' })
    expect(live).toEqual(new Set(['p-train-one']))
    await service.grant(actor, 'members', ['p-train-one', 'p-train-two'])
    const second = await shared.connect('member', two, false)
    expect(second.baseUrl).not.toBe(first.baseUrl)
    expect(await shared.connect('member', one, false)).toEqual(first)
    await service.grant(actor, 'members', ['p-train-two'])
    await shared.reconcile()
    expect(live).toEqual(new Set(['p-train-two']))
    expect(await shared.connect('member', two, false)).toEqual(second)
    await service.remove(actor, 'p-train-one')
    await shared.reconcile()
    expect(await shared.connect('member', two, false)).toEqual(second)
  } finally {
    await imports.stop()
    await shared.stop()
  }
})

it('keeps a catalog job pending through unavailable committed readiness and rechecks without an observer event', async () => {
  vi.useFakeTimers()
  const { service, actor } = fixture()
  const preparation = vi.spyOn(service, 'catalogPreparation').mockRejectedValueOnce(new PlatformDatabaseError('unavailable', 'View is refreshing'))
  const imports = new McpCatalogImports(service, new McpConnectionTest(service, { probe: async () => [{ name: 'weather', inputSchema: {} }] }))
  try {
    await imports.import(actor, input)
    await vi.advanceTimersByTimeAsync(0)
    expect((await service.list(actor))[0]?.catalog?.status).toBe('testing')
    await vi.advanceTimersByTimeAsync(250)
    await imports.drain()
    expect(preparation).toHaveBeenCalledTimes(2)
    expect((await service.list(actor))[0]?.catalog?.status).toBe('ready')
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    await imports.stop()
    preparation.mockRestore()
    vi.useRealTimers()
  }
})

it('cancels its pending readiness recheck when catalog work stops', async () => {
  vi.useFakeTimers()
  const { service, actor } = fixture()
  const preparation = vi.spyOn(service, 'catalogPreparation').mockRejectedValue(new PlatformDatabaseError('unavailable', 'View is refreshing'))
  const imports = new McpCatalogImports(
    service,
    new McpConnectionTest(service, {
      probe: async () => {
        throw Error('Must not probe uncertain readiness')
      },
    }),
  )
  try {
    await imports.import(actor, input)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    await imports.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(preparation).toHaveBeenCalledTimes(1)
  } finally {
    await imports.stop()
    preparation.mockRestore()
    vi.useRealTimers()
  }
})

it('does not schedule a readiness recheck when an in-flight inspection fails after stop', async () => {
  vi.useFakeTimers()
  const { service, actor } = fixture()
  let fail!: (error: Error) => void
  const inspection = new Promise<'ready' | 'waiting'>((_resolve, reject) => {
    fail = reject
  })
  const preparation = vi.spyOn(service, 'catalogPreparation').mockReturnValue(inspection)
  const imports = new McpCatalogImports(
    service,
    new McpConnectionTest(service, {
      probe: async () => {
        throw Error('Must not probe after stop')
      },
    }),
  )
  try {
    await imports.import(actor, input)
    const stopping = imports.stop()
    fail(new PlatformDatabaseError('unavailable', 'View is refreshing'))
    await stopping
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    fail(new Error('Stopped'))
    await imports.stop()
    preparation.mockRestore()
    vi.useRealTimers()
  }
})

it.each(['import', 'update'] as const)('does not begin a %s connection test when readiness completes after catalog shutdown', async mode => {
  vi.useFakeTimers()
  const { service, actor } = fixture()
  let ready!: (state: 'ready') => void
  const inspection = new Promise<'ready'>(resolve => {
    ready = resolve
  })
  const preparation =
    mode === 'import'
      ? vi.spyOn(service, 'catalogPreparation').mockReturnValue(inspection)
      : vi.spyOn(service, 'catalogUpdatePreparation').mockReturnValue(inspection)
  const begin = mode === 'import' ? vi.spyOn(service, 'beginCatalogTest') : vi.spyOn(service, 'testCatalogUpdate')
  const update = vi.spyOn(service, 'beginCatalogUpdate').mockResolvedValue({ name: 'p-update-operation', pending: true })
  const probe = vi.fn(async () => [{ name: 'weather', inputSchema: {} }])
  const imports = new McpCatalogImports(service, new McpConnectionTest(service, { probe }), { probe })
  try {
    if (mode === 'import') await imports.import(actor, input)
    else await imports.update(actor, { name: input.name, version: '2', requestId: 'update-shutdown-request' })
    const stopping = imports.stop()
    ready('ready')
    await stopping
    await vi.advanceTimersByTimeAsync(0)
    expect(begin).not.toHaveBeenCalled()
    expect(probe).not.toHaveBeenCalled()
    if (mode === 'import') expect((await service.list(actor))[0]?.catalog?.status).toBe('failed')
  } finally {
    ready('ready')
    await imports.stop()
    preparation.mockRestore()
    begin.mockRestore()
    update.mockRestore()
    vi.useRealTimers()
  }
})

it('continues an already committed import when its initial projection cannot read current facts', async () => {
  let first = true
  const { service, actor } = fixture(async () => {
    if (first) {
      first = false
      throw new PlatformDatabaseError('unavailable', 'View is refreshing')
    }
  })
  const imports = new McpCatalogImports(service, new McpConnectionTest(service, { probe: async () => [{ name: 'weather', inputSchema: {} }] }))
  try {
    await imports.import(actor, input)
    await imports.drain()
    expect((await service.list(actor))[0]?.catalog?.status).toBe('ready')
  } finally {
    await imports.stop()
  }
})
