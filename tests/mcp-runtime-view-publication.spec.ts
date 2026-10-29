import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PostgresRuntimeDependencyStore } from '../src/adapters/postgres-runtime-dependencies.js'
import { PostgresRuntimeFacts } from '../src/adapters/postgres-runtime-facts.js'
import { DEFAULT_EXECUTION_LIMITS } from '../src/domain/execution-control.js'
import type { McpState } from '../src/domain/mcp-service.js'
import { PlatformDatabaseError } from '../src/domain/platform-database.js'
import { ExecutionControl } from '../src/use-cases/execution-control.js'
import { McpRuntimeDependencies } from '../src/use-cases/mcp-runtime-dependencies.js'
import { McpServices } from '../src/use-cases/mcp-services.js'
import { McpSharedRuntime } from '../src/use-cases/mcp-shared-runtime.js'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import { asyncMcpFacts } from './fixtures/async-mcp-facts.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { runtimeVersion } from './fixtures/runtime-version.js'
import { openTestDatabase } from './support/community-application.js'

it('preserves a live MCP carrier while candidate progress republishes the dependency view and refuses uncertain admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-view-publication-'))
  const database = await openTestDatabase(root)
  const facts = new PostgresRuntimeFacts(database)
  const rows = new PostgresRuntimeDependencyStore(database)
  const account = {
    username: 'member',
    spaceId: 'member',
    groupId: 'members',
    admin: true,
    disabled: false,
    sessionEpoch: 0,
    email: '',
    createdAt: 0,
    updatedAt: 0,
  }
  const service = {
    name: 'p-live',
    generation: 1,
    description: '',
    url: '',
    published: true,
    run: { location: 'shared' as const, command: 'node', args: [], env: [], runtimeDependencies: ['live'] },
  }
  let businessState: McpState = { services: [service], grants: { members: ['p-live'] } }
  const state = asyncMcpFacts({
    read: () => businessState,
    write: next => {
      businessState = next
    },
  })
  const projections: string[][] = []
  const dependencies = new RuntimeDependencies(
    { get: async () => account },
    { view: facts, list: () => rows.list(), save: row => rows.save(row), remove: name => rows.remove(name) },
    {
      isolated: true,
      identity: () => '',
      prepare: async () => {
        throw Error('Preparation is not used')
      },
      recover: async () => {},
      collect: async () => {},
    },
    { now: () => 0 },
  )
  const runtime = new McpRuntimeDependencies(state, dependencies)
  const services = new McpServices(
    {
      get: async () => account,
      list: async () => [account],
      listGroups: async () => [{ id: 'members', name: 'Members', kind: 'ordinary', isDefault: true, memberCount: 1 }],
    },
    state,
    {
      synchronize: async members => {
        projections.push(members.flatMap(member => member.services.map(row => row.name)))
      },
    },
    runtime,
  )
  let live = false,
    permitted = true,
    now = 0,
    release!: () => void,
    entered!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const loading = new Promise<void>(resolve => {
    entered = resolve
  })
  const shared = new McpSharedRuntime(
    {
      isolated: true,
      recover: async () => {},
      start: async (_service, _activity, signal) => {
        live = true
        return {
          target: { name: service.name, baseUrl: 'http://127.0.0.1:4000', credential: '', headers: [] },
          closed: new Promise<number>(resolve =>
            signal.addEventListener(
              'abort',
              () => {
                live = false
                resolve(0)
              },
              { once: true },
            ),
          ),
        }
      },
    },
    new ExecutionControl(
      { get: async () => DEFAULT_EXECUTION_LIMITS, save: async () => {} },
      { start: () => ({ signal: new AbortController().signal, dispose() {} }) },
    ),
    { now: () => now },
    { start: () => () => {} },
    async () => (permitted ? services.runtimeService('member', service.name, false) : undefined),
  )
  let publication: ReturnType<typeof vi.spyOn> | undefined, writing: Promise<void> | undefined, recovering: Promise<void> | undefined
  let recovered = false
  try {
    await rows.save({
      name: 'live',
      source: 'manual',
      prepareCommand: 'true',
      pathDirectories: ['bin'],
      stage: 'ready',
      updatedAt: 0,
      log: '',
      checks: [],
      current: runtimeVersion('a'),
    })
    await facts.initialize()
    await services.recover()
    expect(projections.at(-1)).toEqual(['p-live'])
    const assertCurrent = services.captureLocalPolicy()
    const prepared = (await services.effective('member'))[0]!
    await shared.connect('member', prepared, false)
    const original = PostgresRuntimeDependencyStore.prototype.list
    publication = vi.spyOn(PostgresRuntimeDependencyStore.prototype, 'list').mockImplementationOnce(async function (this: PostgresRuntimeDependencyStore) {
      entered()
      await gate
      return original.call(this)
    })
    writing = rows.save({
      name: 'candidate',
      source: 'manual',
      prepareCommand: 'true',
      pathDirectories: ['bin'],
      stage: 'preparing',
      updatedAt: 1,
      log: 'progress',
      checks: [],
    })
    await loading
    // The original dependency is still committed and usable; only view publication is suspended.
    expect((await rows.list()).find(row => row.name === 'live')?.current?.id).toBe(runtimeVersion('a').id)
    await expect.soft(services.effective('member')).rejects.toMatchObject({ code: 'unavailable' })
    await expect.soft(services.list(account)).resolves.toMatchObject([{ name: 'p-live', preparation: { stage: 'ready' } }])
    expect.soft(() => services.captureLocalPolicy()).toThrow(PlatformDatabaseError)
    expect.soft(assertCurrent).toThrow(PlatformDatabaseError)
    recovering = services.recover().then(() => {
      recovered = true
    })
    await new Promise(resolve => setImmediate(resolve))
    expect.soft(recovered).toBe(false)
    expect.soft(projections.at(-1)).toEqual(['p-live'])
    await expect.soft(shared.reconcile()).rejects.toThrow()
    expect.soft(live).toBe(true)
    await expect.soft(shared.connect('member', prepared, false)).rejects.toMatchObject({ code: 'unavailable' })
    now = 300_000
    await expect.soft(shared.reconcile()).rejects.toThrow()
    expect.soft(live).toBe(false)
    release()
    await writing
    await recovering
    expect(recovered).toBe(true)
    writing = undefined
    publication.mockRestore()
    publication = undefined
    expect((await services.effective('member'))[0]?.name).toBe('p-live')
    await shared.connect('member', prepared, false)
    await shared.reconcile()
    expect(live).toBe(true)
    permitted = false
    await shared.reconcile()
    expect(live).toBe(false)
  } finally {
    release()
    await cleanupOwned(
      async () => {
        await writing
      },
      async () => {
        publication?.mockRestore()
      },
      () => shared.stop(),
      () => services.stop(),
      async () => {
        await recovering
      },
      () => facts.close(),
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
