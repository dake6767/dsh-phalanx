import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { PostgresMcpStateQuery } from '../src/adapters/postgres-mcp-state-query.js'
import { runtimeVersion } from './fixtures/runtime-version.js'
import { createRuntimeStorage } from '../src/composition/runtime-storage.js'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import { McpRuntimeDependencies } from '../src/use-cases/mcp-runtime-dependencies.js'
import { McpDesiredState } from '../src/use-cases/mcp-desired-state.js'
import type { McpRepositories, McpRuntimePort, McpSnapshot } from '../src/ports/mcp-services.js'
import type { PlatformUnitOfWorkPort } from '../src/ports/platform-unit-of-work.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { createMcpStorage } from '../src/composition/mcp-storage.js'
import { PostgresRuntimeDependencyStore } from '../src/adapters/postgres-runtime-dependencies.js'
import { PostgresRuntimeReferences } from '../src/adapters/postgres-runtime-references.js'
import type { McpService } from '../src/domain/mcp-service.js'
import { openTestDatabase } from './support/community-application.js'

it('commits owner diffs, preserves empty and false policy facts, rejects a stale policy and keeps unrelated services independent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-owner-diffs-'))
  const database = await openTestDatabase(root)
  const state = createMcpStorage(database)
  try {
    await state.initialize()
    const accounts = new PostgresCommunityAccountStore(database)
    const member = await accounts.create({ username: 'member', password: 'fixture-password', email: '' })
    const before = await state.read()
    const service = (name: string, credential: string) => ({
      name,
      generation: 1,
      description: '',
      url: 'https://api.example.test/mcp',
      credential,
      published: true,
    })
    await state.update(before, {
      ...before,
      services: [service('p-first', 'first-private-key'), service('p-second', 'second-private-key')],
      grants: { [member.groupId]: ['p-first'] },
      selections: { [member.spaceId]: ['p-first'] },
      preferences: { [member.spaceId]: { 'p-first': false } },
      catalogRequests: ['request-1234567890'],
    })
    const initial = await state.read()
    expect(initial.preferences?.[member.spaceId]).toEqual({ 'p-first': false })
    expect(initial.services[0]?.credential).toBe('first-private-key')
    expect(JSON.stringify(state.view.read())).not.toContain('first-private-key')
    const stored =
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.mcp_services')) +
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.mcp_secrets'))
    expect(stored).not.toContain('first-private-key')
    const envelope = await database.query('SELECT value FROM dsh_phalanx.mcp_secrets WHERE service=$1', ['p-first'])
    await Promise.all([
      state.update(initial, {
        ...initial,
        services: initial.services.map(row => (row.name === 'p-first' ? { ...row, generation: 2, description: 'First changed' } : row)),
      }),
      state.update(initial, {
        ...initial,
        services: initial.services.map(row => (row.name === 'p-second' ? { ...row, generation: 2, description: 'Second changed' } : row)),
      }),
    ])
    expect((await state.read()).services.map(row => row.description)).toEqual(['First changed', 'Second changed'])
    expect(await database.query('SELECT value FROM dsh_phalanx.mcp_secrets WHERE service=$1', ['p-first'])).toEqual(envelope)
    const stale = await state.read()
    await state.update(stale, { ...stale, grants: { [member.groupId]: [] } })
    expect((await state.read()).grants).toHaveProperty(member.groupId, [])
    await expect(state.update(stale, { ...stale, grants: { [member.groupId]: [] } })).rejects.toMatchObject({ code: 'platform-configuration-conflict' })
    const current = await state.read(),
      version = state.view.version()
    await state.update(current, current)
    expect(state.view.version()).toBe(version)
    await state.update(current, { ...current, services: [], grants: {}, selections: {}, preferences: {}, catalogRequests: [] })
    expect(await state.read()).toMatchObject({ services: [], revision: 2, catalogRequests: ['request-1234567890'] })
  } finally {
    try {
      await state.close()
    } finally {
      try {
        await database.close()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  }
})

it('keeps current, nested candidate and promotion endpoints referenced until the MCP owner releases them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-all-runtime-bindings-'))
  const database = await openTestDatabase(root),
    state = createMcpStorage(database)
  try {
    await state.initialize()
    const runtime = new PostgresRuntimeDependencyStore(database),
      references = new PostgresRuntimeReferences(database)
    const dependencies = ['run', 'own', 'target', 'from', 'to', 'candidate', 'candidate-run', 'candidate-target', 'candidate-from', 'candidate-to']
    for (const name of dependencies)
      await runtime.save({ name, prepareCommand: 'install', pathDirectories: ['bin'], source: 'manual', stage: 'preparing', updatedAt: 0, log: '', checks: [] })
    const service: McpService = {
      name: 'p-root',
      generation: 1,
      description: '',
      url: '',
      run: { location: 'shared', command: 'node', args: [], env: [], runtimeDependencies: ['run'] },
      dependencyName: 'own',
      dependencyTarget: 'target',
      dependencyPromotion: { from: 'from', to: 'to' },
      catalogUpdate: {
        name: 'p-private',
        requestId: 'private-request',
        version: '2',
        baseGeneration: 1,
        actor: { username: 'admin', spaceId: 'admin-space', sessionEpoch: 0 },
        status: 'preparing',
        candidate: {
          name: 'p-private',
          generation: 2,
          description: '',
          url: '',
          dependencyName: 'candidate',
          dependencyTarget: 'candidate-target',
          dependencyPromotion: { from: 'candidate-from', to: 'candidate-to' },
          run: { location: 'shared', command: 'node', args: [], env: [], runtimeDependencies: ['candidate-run'] },
        },
      },
    }
    await state.update(await state.read(), { services: [service], grants: {} })
    expect((await state.read()).services[0]).toMatchObject(service)
    for (const name of dependencies) {
      expect(await references.list(name)).toEqual([{ kind: 'mcp', name: 'p-root' }])
      await expect(runtime.remove(name)).rejects.toMatchObject({ code: 'runtime-dependency-referenced', params: { references: 'mcp: p-root' } })
    }
    const reopened = createMcpStorage(database)
    try {
      await reopened.initialize()
      expect((await reopened.read()).services[0]).toMatchObject(service)
    } finally {
      await reopened.close()
    }
    const withCandidate = await state.read()
    const { catalogUpdate, dependencyPromotion, ...active } = withCandidate.services[0]!
    void catalogUpdate
    void dependencyPromotion
    await state.update(withCandidate, { ...withCandidate, services: [active] })
    for (const name of dependencies.filter(name => name.startsWith('candidate') || name === 'from' || name === 'to')) {
      expect(await references.list(name)).toEqual([])
      await runtime.remove(name)
    }
    for (const name of ['run', 'own', 'target']) await expect(runtime.remove(name)).rejects.toMatchObject({ code: 'runtime-dependency-referenced' })
    const current = await state.read()
    await state.update(current, { ...current, services: [{ name: 'p-root', generation: 3, description: '', url: 'https://example.test' }] })
    for (const name of dependencies) await runtime.remove(name)
    expect(await runtime.list()).toEqual([])
  } finally {
    await cleanupOwned(
      () => state.close(),
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('purges selections added after an unpublish snapshot and cascades account and group policies', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-policy-lifetimes-'))
  const database = await openTestDatabase(root),
    state = createMcpStorage(database)
  try {
    await state.initialize()
    const accounts = new PostgresCommunityAccountStore(database)
    const member = await accounts.create({ username: 'member', password: 'fixture-password', email: '' })
    const service = { name: 'p-public', generation: 1, description: '', url: 'https://example.test', published: true }
    await state.update(await state.read(), { services: [service], grants: { [member.groupId]: ['p-public'] } })
    const beforeSelection = await state.read()
    await state.update(beforeSelection, {
      ...beforeSelection,
      selections: { [member.spaceId]: ['p-public'] },
      preferences: { [member.spaceId]: { 'p-public': false } },
    })
    await state.update(beforeSelection, { ...beforeSelection, services: [{ ...service, published: false }] })
    expect((await state.read()).selections?.[member.spaceId]).toEqual([])
    const unpublished = await state.read()
    await state.update(unpublished, { ...unpublished, services: [{ ...service, published: true }] })
    expect((await state.read()).selections?.[member.spaceId]).toEqual([])
    const selecting = createMcpStorage(database)
    try {
      await selecting.initialize()
      const staleSelection = await selecting.read(),
        current = await state.read()
      await state.update(current, { ...current, services: [{ ...current.services[0]!, published: false }] })
      await expect(selecting.update(staleSelection, { ...staleSelection, selections: { [member.spaceId]: ['p-public'] } })).rejects.toMatchObject({
        code: 'platform-configuration-conflict',
      })
      expect((await selecting.read()).selections?.[member.spaceId]).toEqual([])
    } finally {
      await selecting.close()
    }
    await database.query('DELETE FROM dsh_phalanx.accounts WHERE space_id=$1', [member.spaceId])
    expect(state.view.read().preferences).toEqual({})
    expect(state.view.read().selections).toEqual({})
    expect(await database.query('SELECT * FROM dsh_phalanx.mcp_member_settings')).toEqual([])
    await database.query('DELETE FROM dsh_phalanx.groups WHERE id=$1', [member.groupId])
    expect(state.view.read().grants).toEqual({})
    expect(await database.query('SELECT * FROM dsh_phalanx.mcp_group_grants')).toEqual([])
  } finally {
    await cleanupOwned(
      () => state.close(),
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('uses one injected unit for runtime and MCP mutations and never cancels preparation on rollback', async () => {
  const snapshot: McpSnapshot = {
    services: [
      {
        name: 'p-runtime',
        generation: 1,
        description: '',
        url: '',
        run: { location: 'shared', command: 'node', args: [], env: [], prepareCommand: 'install' },
      },
    ],
    grants: {},
    versions: { services: {}, groups: {}, members: {} },
    protectedRevision: 'empty',
  }
  const events: string[] = []
  const rows: McpRepositories = {
    services: {
      get: vi.fn(),
      list: vi.fn(),
      lock: vi.fn(),
      remove: vi.fn(),
      save: async () => {
        events.push('service')
      },
    },
    policies: { groups: vi.fn(), members: vi.fn(), saveGroup: vi.fn(), removeGroup: vi.fn(), saveMember: vi.fn(), removeMember: vi.fn() },
    metadata: { generation: vi.fn(), requests: vi.fn(), advance: vi.fn(), appendRequests: vi.fn() },
    runtime: {
      list: vi.fn(),
      remove: vi.fn(),
      save: async () => {
        events.push('runtime')
      },
    },
  }
  let reject = true
  const work: PlatformUnitOfWorkPort<McpRepositories> = {
    run: async (operation, committed) => {
      const result = await operation(rows)
      if (reject) throw Error('rejected COMMIT')
      events.push('committed')
      committed?.(result)
      return result
    },
  }
  const runtime: McpRuntimePort = {
    transaction: repository => ({
      configure: async service => {
        await repository.save({
          name: 'managed',
          source: 'manual',
          stage: 'preparing',
          prepareCommand: 'install',
          pathDirectories: [],
          updatedAt: 0,
          log: '',
          checks: [],
        })
        return { ...service, dependencyName: 'managed' }
      },
      committed: () => {
        events.push('cancel-old-preparation')
      },
    }),
    ready: () => undefined,
    view: () => undefined,
    changed: vi.fn(),
    restart: vi.fn(),
  }
  const desired = new McpDesiredState({ read: async () => snapshot }, work, { read: () => snapshot, version: () => 'empty' })
  // Reconciliation binds the real application's runtime mutations to the injected transaction.
  await expect(desired.reconcile(runtime)).rejects.toThrow('rejected COMMIT')
  expect(events).toEqual(['runtime', 'service'])
  events.length = 0
  reject = false
  await desired.reconcile(runtime)
  expect(events).toEqual(['runtime', 'service', 'committed', 'cancel-old-preparation'])
})

it('rolls real MCP managed registration and its bindings back when the subsequent service COMMIT fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-managed-register-rollback-'))
  const database = await openTestDatabase(root),
    state = createMcpStorage(database),
    storage = createRuntimeStorage(database)
  const prepare = vi.fn(async () => {
    throw Error('Preparation cannot run in SQL')
  })
  const dependencies = new RuntimeDependencies(
    { get: async () => undefined },
    storage.store,
    {
      isolated: true,
      identity: input => input.prepareCommand,
      recover: async () => {},
      collect: async () => {},
      prepare,
    },
    { now: () => 0 },
    storage.references,
  )
  try {
    await storage.initialize()
    await state.initialize()
    const service: McpService = {
      name: 'p-register',
      generation: 1,
      description: '',
      url: '',
      run: { location: 'shared', command: 'node', args: ['server.js'], env: [], prepareCommand: 'install-pinned' },
    }
    await state.update(await state.read(), { services: [service], grants: {} })
    const before = await state.read(),
      version = state.view.version()
    await database.query(`CREATE TABLE dsh_phalanx.reject_registration_parent(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.reject_registration_child(id integer REFERENCES dsh_phalanx.reject_registration_parent DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_registration() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.reject_registration_child VALUES(1); RETURN NULL; END $$;
      CREATE TRIGGER reject_registration AFTER UPDATE ON dsh_phalanx.mcp_services FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_registration();`)
    await expect(state.reconcile(new McpRuntimeDependencies(state, dependencies))).rejects.toMatchObject({ sqlState: '23503' })
    expect(await state.read()).toEqual(before)
    expect(state.view.version()).toBe(version)
    expect(await storage.store.list()).toEqual([])
    expect(await database.query('SELECT * FROM dsh_phalanx.mcp_runtime_dependencies')).toEqual([])
    expect(prepare).not.toHaveBeenCalled()
    await database.query('DROP TRIGGER reject_registration ON dsh_phalanx.mcp_services')
    await state.reconcile(new McpRuntimeDependencies(state, dependencies))
    expect(await storage.store.list()).toHaveLength(1)
    expect((await state.read()).services[0]?.run).not.toHaveProperty('prepareCommand')
    expect(await database.query('SELECT * FROM dsh_phalanx.mcp_runtime_dependencies')).not.toEqual([])
    expect(prepare).not.toHaveBeenCalled()
  } finally {
    await cleanupOwned(
      () => dependencies.stop(),
      () => state.close(),
      () => storage.close(),
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it('finishes a committed MCP promotion even when policy publication fails, while the view remains unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-promote-publication-'))
  const database = await openTestDatabase(root),
    state = createMcpStorage(database),
    storage = createRuntimeStorage(database)
  const dependencies = new RuntimeDependencies(
    { get: async () => undefined },
    storage.store,
    {
      isolated: true,
      identity: input => input.prepareCommand,
      recover: async () => {},
      collect: async () => {},
      prepare: async () => {
        throw Error('No preparation during promotion')
      },
    },
    { now: () => 0 },
    storage.references,
  )
  let publication: ReturnType<typeof vi.spyOn> | undefined
  let committed = 0
  try {
    await storage.initialize()
    await state.initialize()
    const base = {
      prepareCommand: 'install',
      pathDirectories: ['bin'],
      source: 'mcp-catalog' as const,
      stage: 'ready' as const,
      updatedAt: 0,
      log: '',
      checks: [],
    }
    await storage.store.save({ ...base, name: 'stable', managedOrigin: 'mcp:stable', current: runtimeVersion('a'), preparationIdentity: 'stable' })
    await storage.store.save({
      ...base,
      name: 'candidate',
      managedOrigin: 'mcp:candidate',
      candidate: true,
      replaces: 'stable',
      current: runtimeVersion('b'),
      preparationIdentity: 'candidate',
    })
    const service: McpService = {
      name: 'p-promote',
      generation: 1,
      description: '',
      url: '',
      dependencyName: 'candidate',
      dependencyPromotion: { from: 'candidate', to: 'stable' },
      run: { location: 'shared', command: 'node', args: [], env: [], runtimeDependencies: ['candidate'] },
    }
    await state.update(await state.read(), { services: [service], grants: {} })
    const runtime = new McpRuntimeDependencies(state, dependencies),
      transaction = runtime.transaction.bind(runtime)
    vi.spyOn(runtime, 'transaction').mockImplementation(rows => {
      const scope = transaction(rows)
      return {
        configure: async input => {
          const configured = await scope.configure(input)
          publication = vi.spyOn(PostgresMcpStateQuery.prototype, 'read').mockRejectedValueOnce(Error('policy publication failed'))
          return configured
        },
        committed: () => {
          committed++
          scope.committed()
        },
      }
    })
    await expect(state.reconcile(runtime)).rejects.toThrow('policy publication failed')
    publication?.mockRestore()
    expect(committed).toBe(1)
    expect((await storage.store.list()).find(row => row.name === 'stable')).toMatchObject({ current: runtimeVersion('b'), previous: runtimeVersion('a') })
    expect((await state.read()).services[0]).toMatchObject({ dependencyName: 'stable', run: { runtimeDependencies: ['stable'] } })
    expect((await state.read()).services[0]).not.toHaveProperty('dependencyPromotion')
    expect(() => state.view.version()).toThrow(/not ready/u)
    await state.initialize()
    expect(state.view.read().services[0]?.dependencyName).toBe('stable')
  } finally {
    publication?.mockRestore()
    await cleanupOwned(
      () => dependencies.stop(),
      () => state.close(),
      () => storage.close(),
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})
