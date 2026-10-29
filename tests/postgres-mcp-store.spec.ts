import { seedMcpParents } from './fixtures/mcp-parents.js'
import { filterMcpResponse, mcpSecrets } from '../src/domain/mcp-protocol.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createMcpStorage } from '../src/composition/mcp-storage.js'
import { mergeMcpInput, mcpSettings, mcpWriteInput, validateMcpSettings, type McpState } from '../src/domain/mcp-service.js'
import { openTestDatabase } from './support/community-application.js'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { McpServices } from '../src/use-cases/mcp-services.js'

it('reopens MCP credentials, templates and process environment from encrypted PostgreSQL fields with grants intact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-mcp-store-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const state: McpState = {
    revision: 2,
    services: [
      {
        name: 'p-remote',
        generation: 1,
        description: 'Remote service',
        url: 'https://remote.example.test/mcp',
        credential: 'fictional-mcp-key',
        headers: [
          { name: 'Authorization', value: 'Bearer {credential}' },
          { name: 'X-Private', value: 'fictional-mcp-header' },
        ],
        query: [{ name: 'token', value: 'fictional-mcp-query' }],
      },
      {
        name: 'p-shared',
        generation: 2,
        published: true,
        testStatus: 'passed',
        description: 'Shared service',
        url: '',
        credentials: { account: 'fictional-mcp-account' },
        run: { location: 'shared', command: 'node', args: ['server.js'], env: [{ name: 'PRIVATE_KEY', value: 'fictional-mcp-environment' }] },
      },
    ],
    grants: { team: ['p-remote'] },
    selections: { member: ['p-shared'] },
    preferences: { member: { 'p-remote': false } },
    catalogRequests: ['retired-request'],
  }
  try {
    const store = createMcpStorage(database)
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    expect(await store.read()).toMatchObject({ services: [], grants: {} })
    await seedMcpParents(database, { spaces: ['member'] })
    await store.update(await store.read(), state)
    expect(await store.read()).toMatchObject(state)
    const rows =
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.mcp_services')) +
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.mcp_secrets'))
    for (const secret of ['fictional-mcp-key', 'fictional-mcp-header', 'fictional-mcp-query', 'fictional-mcp-account', 'fictional-mcp-environment'])
      expect(rows).not.toContain(secret)
    expect(rows).toContain('Remote service')
    expect(rows).toContain('PRIVATE_KEY')
    const reopened = createMcpStorage(other)
    await reopened.initialize()
    expect(await reopened.read()).toMatchObject(state)
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('waits for MCP COMMIT before refreshing member projections and finishing management writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-mcp-response-'))
  const database = await openTestDatabase(root)
  let release!: () => void, pendingWrite: Promise<void> | undefined
  try {
    const accounts = new PostgresCommunityAccountStore(database)
    const actor = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const store = createMcpStorage(database)
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    await store.update(await store.read(), { services: [], grants: {} })
    let entered!: () => void,
      completed = false,
      refreshed = false
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    const holder = database.transaction(async sql => {
      await sql.query('SELECT id FROM dsh_phalanx.mcp_metadata WHERE id=1 FOR UPDATE')
      entered()
      await gate
    })
    await began
    const management = new McpServices(
      accounts,
      {
        read: store.read.bind(store),
        view: store.view,
        reconcile: store.reconcile.bind(store),
        update: async (previous, state) => {
          pendingWrite = store.update(previous, state)
          return pendingWrite
        },
      },
      {
        synchronize: async () => {
          refreshed = true
        },
      },
    )
    const saving = management
      .save(actor, { name: 'p-service', description: '', url: 'https://upstream.example.test', credential: 'fictional-key' })
      .then(() => {
        completed = true
      })
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await database.query<{ waiting: string }>(
                "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            )[0]!.waiting,
          ),
        )
        .toBeGreaterThan(0)
      expect(completed).toBe(false)
      expect(refreshed).toBe(false)
      release()
      await holder
      await saving
      expect(refreshed).toBe(true)
      expect((await store.read()).services[0]?.name).toBe('p-service')
    } finally {
      release()
      await Promise.allSettled([holder, saving, pendingWrite])
    }
  } finally {
    release?.()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('protects known MCP secrets embedded in URLs and process arguments while sanitizing echoed display metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-mcp-embedded-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const key = 'fictional-"private\\mcp-key'
  const service = {
    name: 'p-shared',
    generation: 1,
    description: 'echo ' + key,
    credential: key,
    url: 'https://upstream.example.test/mcp?token=' + encodeURIComponent(key),
    run: {
      location: 'shared' as const,
      command: 'node',
      args: ['server.js', '--key=' + key],
      prepareCommand: 'echo ' + key,
      env: [{ name: 'PRIVATE_KEY', value: key }],
    },
    tools: [{ name: 'inspect', description: 'echo ' + key, inputSchema: { type: 'object', properties: { value: { default: key } } } }],
  }
  try {
    const store = createMcpStorage(database)
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    await store.update(await store.read(), { services: [service], grants: {} })
    const metadata = JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.mcp_services'))
    for (const value of [key, JSON.stringify(key).slice(1, -1), encodeURIComponent(key)]) expect(metadata).not.toContain(value)
    expect(metadata).toContain('server.js')
    expect(metadata).toContain('PRIVATE_KEY')
    const reopened = createMcpStorage(other)
    await reopened.initialize()
    expect((await reopened.read()).services[0]).toMatchObject({ url: service.url, credential: key, run: service.run, description: 'echo [redacted]' })
    expect(JSON.stringify((await reopened.read()).services[0]!.tools)).not.toContain(JSON.stringify(key).slice(1, -1))
    expect((await store.read()).services[0]!.description).toBe('echo [redacted]')
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('drains an accepted MCP write before closing, rejects new writes and keeps the shared database open', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-mcp-close-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  let release!: () => void
  try {
    const store = createMcpStorage(database)
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    await store.update(await store.read(), { services: [], grants: {} })
    let entered!: () => void,
      closed = false
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    const holder = database.transaction(async sql => {
      await sql.query('SELECT id FROM dsh_phalanx.mcp_metadata WHERE id=1 FOR UPDATE')
      entered()
      await gate
    })
    await began
    const state: McpState = {
      services: [{ name: 'p-service', generation: 1, description: '', url: 'https://upstream.example.test', credential: 'fictional-key' }],
      grants: {},
    }
    const previous = await store.read()
    const writing = store.update(previous, state)
    let closing: Promise<void> | undefined
    try {
      await expect
        .poll(async () =>
          Number(
            (
              await database.query<{ waiting: string }>(
                "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            )[0]!.waiting,
          ),
        )
        .toBeGreaterThan(0)
      closing = store.close().then(() => {
        closed = true
      })
      await expect(store.update(previous, { services: [], grants: {} })).rejects.toThrow(/closed/u)
      expect(closed).toBe(false)
      release()
      await holder
      await writing
      await closing
      await expect(store.read()).rejects.toThrow(/closed/u)
      expect((await database.health()).state).toBe('connected')
      const reopened = createMcpStorage(other)
      await reopened.initialize()
      expect(await reopened.read()).toMatchObject(state)
      expect(reopened.view.version()).toEqual(expect.any(String))
    } finally {
      release()
      await Promise.allSettled([holder, writing, closing])
    }
  } finally {
    release?.()
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps MCP policy, credentials and authorization version unchanged when PostgreSQL rejects COMMIT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-mcp-commit-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const state: McpState = {
    revision: 1,
    services: [{ name: 'p-service', generation: 1, description: '', url: 'https://upstream.example.test', credential: 'fictional-key' }],
    grants: { team: ['p-service'] },
  }
  try {
    const store = createMcpStorage(database)
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    await store.update(await store.read(), state)
    const committed = await store.read()
    const committedVersion = store.view.version()
    await database.query(`CREATE TABLE dsh_phalanx.commit_parents(id integer PRIMARY KEY);
      CREATE TABLE dsh_phalanx.commit_children(id integer REFERENCES dsh_phalanx.commit_parents(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE FUNCTION dsh_phalanx.reject_mcp_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN INSERT INTO dsh_phalanx.commit_children VALUES(42); RETURN NULL; END $$;
      CREATE TRIGGER reject_mcp_commit AFTER UPDATE ON dsh_phalanx.mcp_services FOR EACH ROW EXECUTE FUNCTION dsh_phalanx.reject_mcp_commit();`)
    const next = { ...state, grants: {}, services: state.services.map(service => ({ ...service, credential: 'replacement-key' })) }
    await expect(store.update(await store.read(), next)).rejects.toMatchObject({ code: 'query-failed', sqlState: '23503' })
    expect(await store.read()).toEqual(committed)
    expect(store.view.version()).toBe(committedVersion)
    const reopened = createMcpStorage(other)
    await reopened.initialize()
    expect(await reopened.read()).toEqual(committed)
    expect(reopened.view.version()).toBe(committedVersion)
    await database.query('DROP TRIGGER reject_mcp_commit ON dsh_phalanx.mcp_services')
    await store.update(await store.read(), next)
    expect(await store.read()).toMatchObject(next)
    expect(store.view.version()).not.toBe(committedVersion)
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('retains the MCP authorization version across reopen and rejects writes from an older snapshot', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-mcp-version-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const store = createMcpStorage(database),
    stale = createMcpStorage(other),
    reopened = createMcpStorage(other)
  try {
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    const initial = store.view.version()
    await store.update(await store.read(), {
      revision: 1,
      services: [{ name: 'p-service', generation: 1, description: '', url: 'https://upstream.example.test', credential: 'fictional-key' }],
      grants: { team: ['p-service'] },
    })
    const originalVersion = store.view.version()
    expect(originalVersion).not.toBe(initial)
    await stale.initialize()
    expect(stale.view.version()).toBe(originalVersion)
    const previous = await stale.read()
    const newer = { ...previous, services: previous.services.map(row => ({ ...row, credential: 'replacement-key' })) }
    await store.update(await store.read(), newer)
    const committedVersion = store.view.version()
    expect(committedVersion).not.toBe(originalVersion)
    await expect(
      stale.update(previous, { ...previous, services: previous.services.map(row => ({ ...row, description: 'obsolete intent' })) }),
    ).rejects.toMatchObject({ code: 'platform-configuration-conflict' })
    expect((await stale.read()).services[0]?.credential).toBe('replacement-key')
    await reopened.initialize()
    expect(reopened.view.version()).toBe(committedVersion)
    expect((await reopened.read()).services[0]?.credential).toBe('replacement-key')
  } finally {
    await Promise.all([store.close(), stale.close(), reopened.close()])
    try {
      await Promise.all([database.close(), other.close()])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})

it('protects a pending MCP catalog candidate separately and rebinds its values when it becomes the active service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-mcp-candidate-'))
  const database = await openTestDatabase(root),
    other = await openTestDatabase(root)
  const candidate = {
    name: 'p-staged',
    generation: 2,
    description: 'Next service',
    url: 'https://next.example.test/mcp',
    credential: 'fictional-mcp-candidate-key',
    headers: [{ name: 'X-Private', value: 'fictional-mcp-candidate-header' }],
  }
  const state: McpState = {
    revision: 2,
    grants: { team: ['p-active'] },
    catalogRequests: ['update-request'],
    services: [
      {
        name: 'p-active',
        generation: 1,
        description: 'Current service',
        url: 'https://current.example.test/mcp',
        credential: 'fictional-mcp-active-key',
        catalogUpdate: {
          name: candidate.name,
          requestId: 'update-request',
          version: '2',
          baseGeneration: 1,
          actor: { username: 'admin', spaceId: 'space', sessionEpoch: 0 },
          status: 'testing',
          candidate,
        },
      },
    ],
  }
  try {
    const store = createMcpStorage(database)
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    await store.update(await store.read(), state)
    const facts =
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.mcp_services')) +
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.mcp_secrets'))
    for (const value of [candidate.credential, candidate.headers[0]!.value]) expect(facts).not.toContain(value)
    const reopened = createMcpStorage(other)
    await reopened.initialize()
    expect(await reopened.read()).toMatchObject(state)
    const promoted: McpState = { ...state, services: [{ ...candidate, name: 'p-active' }] }
    await reopened.update(await reopened.read(), promoted)
    const active = createMcpStorage(database)
    await active.initialize()
    expect(await active.read()).toMatchObject(promoted)
    expect(await database.query("SELECT * FROM dsh_phalanx.mcp_secrets WHERE scope<>'current'")).toEqual([])
  } finally {
    await Promise.all([database.close(), other.close()])
    await rm(root, { recursive: true, force: true })
  }
})

it('returns only configured summaries for every MCP secret field through management views', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-mcp-management-view-'))
  const database = await openTestDatabase(root),
    store = createMcpStorage(database)
  try {
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    const accounts = new PostgresCommunityAccountStore(database)
    const actor = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const key = 'fictional-writeonly-mcp-key'
    const management = new McpServices(accounts, store, { synchronize: async () => {} })
    await management.save(actor, {
      name: 'p-service',
      description: '',
      url: 'https://example.test/mcp?key=' + key,
      credential: key,
      credentials: { second: key },
      headers: [{ name: 'X-Key', value: key }],
      query: [{ name: 'key', value: key }],
    })
    const view = (await management.list(actor))[0]!
    expect(JSON.stringify(view)).not.toContain(key)
    expect(view).toMatchObject({
      credential: { configured: true, last4: '-key' },
      credentials: { second: { configured: true, last4: '-key' } },
      headers: [{ name: 'X-Key', configured: true, last4: '-key' }],
      query: [{ name: 'key', configured: true, last4: '-key' }],
    })
    expect(JSON.stringify(await management.group(actor, actor.groupId))).not.toContain(key)
  } finally {
    await store.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('retains blank MCP secrets by name, replaces protected scalars and clears only on explicit intent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-mcp-blankkeep-'))
  const database = await openTestDatabase(root),
    store = createMcpStorage(database)
  try {
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    const accounts = new PostgresCommunityAccountStore(database)
    const actor = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const management = new McpServices(accounts, store, { synchronize: async () => {} })
    const key = 'fictional-writeonly-blankkeep-key'
    const original = {
      name: 'p-service',
      description: '',
      url: 'https://example.test/mcp?key=' + key,
      credential: key,
      credentials: { second: key },
      headers: [{ name: 'X-Key', value: key }],
      query: [{ name: 'key', value: key }],
    }
    await management.save(actor, original)
    for (const malformed of [{ url: false }, { url: null }, { headers: [{ name: 42, value: '' }] }]) {
      await expect(
        management.save(actor, { ...original, ...malformed } as unknown as import('../src/domain/admin-contract.js').CommunityMcpInput),
      ).rejects.toMatchObject({ code: 'mcp-service-invalid' })
    }
    let draft = mcpWriteInput((await management.list(actor))[0]!)
    await management.save(actor, { ...draft, description: 'Changed', credential: '', credentials: { second: '' }, headers: [{ name: 'x-key', value: '' }] })
    expect(await management.diagnostic('admin', original.name)).toMatchObject({
      url: original.url,
      credential: key,
      credentials: { second: key },
      headers: [{ name: 'x-key', value: key }],
      query: original.query,
    })
    draft = mcpWriteInput((await management.list(actor))[0]!)
    await management.save(actor, {
      ...draft,
      url: 'https://replacement.example.test/mcp',
      clearCredential: true,
      removeCredentials: ['second'],
      headers: [],
      query: [],
    })
    expect(await management.diagnostic('admin', original.name)).toMatchObject({
      url: 'https://replacement.example.test/mcp',
      credential: '',
      credentials: {},
      headers: [],
      query: [],
    })
    expect((await management.list(actor))[0]).toMatchObject({
      url: 'https://replacement.example.test/mcp',
      protectedFields: {},
      credential: { configured: false, last4: '' },
    })
  } finally {
    await store.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('retains protected arguments by their source slot when earlier arguments are removed and rejects stale references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-mcp-retained-arguments-'))
  const database = await openTestDatabase(root),
    store = createMcpStorage(database)
  try {
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    const accounts = new PostgresCommunityAccountStore(database)
    const actor = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const key = 'fictional-protected-argument-key'
    const management = new McpServices(
      accounts,
      store,
      { synchronize: async () => {} },
      {
        ready: () => ({ directory: '/fixture/prepared' }),
        view: () => ({ stage: 'ready', updatedAt: 0, log: 'echo ' + key }),
        changed: async () => {},
        restart() {},
      },
    )
    await management.save(actor, {
      name: 'p-process',
      description: '',
      url: '',
      credential: key,
      run: { location: 'shared', command: 'runner-' + key, args: ['ordinary', '--key=' + key, 'tail'], env: [{ name: 'KEY', value: key }] },
    })
    for (const command of [false, 0, null]) {
      await expect(
        management.save(actor, {
          name: 'p-process',
          description: '',
          url: '',
          run: { location: 'shared', command, args: [], env: [] },
        } as unknown as import('../src/domain/admin-contract.js').CommunityMcpInput),
      ).rejects.toMatchObject({ code: 'mcp-service-invalid' })
    }
    const view = (await management.list(actor))[0]!
    expect(JSON.stringify(view)).not.toContain(key)
    expect(view.run).toMatchObject({ command: '', args: ['ordinary', '', 'tail'], env: [{ name: 'KEY', configured: true, last4: '-key' }] })
    expect(view.preparation?.log).toBe('echo [redacted]')
    const draft = mcpWriteInput(view)
    await management.save(actor, {
      ...draft,
      run: { ...draft.run!, args: ['', 'tail'] },
      retainedArguments: [{ index: 0, sourceIndex: 1, generation: view.generation }],
    })
    expect(await management.diagnostic('admin', 'p-process')).toMatchObject({
      run: { command: 'runner-' + key, args: ['--key=' + key, 'tail'], env: [{ name: 'KEY', value: key }] },
    })
    await expect(management.save(actor, draft)).rejects.toMatchObject({ code: 'mcp-service-invalid' })
    const current = (await management.list(actor))[0]!,
      next = mcpWriteInput(current)
    await expect(management.save(actor, { ...next, retainedArguments: [{ index: 0, sourceIndex: 1, generation: current.generation }] })).rejects.toMatchObject({
      code: 'mcp-service-invalid',
    })
    await management.save(actor, { ...next, run: { ...next.run!, command: 'node', args: [] }, retainedArguments: [] })
    expect((await management.list(actor))[0]).toMatchObject({ run: { command: 'node', args: [] }, protectedFields: {} })
    const generation = (await management.list(actor))[0]!.generation
    await management.recordTest(actor, 'p-process', generation, [{ name: 'echo', description: 'echo ' + key, inputSchema: { default: key } }])
    await management.publish(actor, 'p-process', true)
    expect(JSON.stringify(await management.list(actor))).not.toContain(key)
    expect(JSON.stringify(await management.group(actor, actor.groupId))).not.toContain(key)
    expect(JSON.stringify(await management.market(actor))).not.toContain(key)
    expect(JSON.stringify(await database.query('SELECT configuration FROM dsh_phalanx.mcp_services'))).not.toContain(key)
  } finally {
    await store.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['rotate', 'clear'] as const)('keeps retained MCP argument secrets protected after credential %s and across reopening', async action => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-mcp-retained-classification-'))
  const database = await openTestDatabase(root),
    store = createMcpStorage(database),
    reopened = createMcpStorage(database)
  const key = 'fictional-original-argument-key'
  try {
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    const accounts = new PostgresCommunityAccountStore(database),
      actor = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const management = new McpServices(accounts, store, { synchronize: async () => {} })
    await management.save(actor, {
      name: 'p-history',
      description: '',
      url: '',
      credential: key,
      run: { location: 'shared', command: 'node', args: ['ordinary.js', '--key=' + key], env: [] },
    })
    const draft = mcpWriteInput((await management.list(actor))[0]!)
    await management.save(actor, {
      ...draft,
      ...(action === 'rotate' ? { credential: 'fictional-replacement-key' } : { clearCredential: true }),
      run: { ...draft.run!, args: [''] },
      retainedArguments: draft.retainedArguments!.map(ref => ({ ...ref, index: 0 })),
    })
    const metadata =
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.mcp_services')) +
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.mcp_secrets'))
    expect(metadata).not.toContain(key)
    expect(JSON.stringify(await management.list(actor))).not.toContain(key)
    await reopened.initialize()
    const restored = new McpServices(accounts, reopened, { synchronize: async () => {} }),
      service = (await reopened.read()).services[0]!
    expect(service.run?.args).toEqual(['--key=' + key])
    expect((await restored.list(actor))[0]?.protectedFields['args/0']).toMatchObject({ configured: true, last4: '-key' })
    expect(JSON.stringify(filterMcpResponse({ jsonrpc: '2.0', id: 1, result: { echoed: key } }, [], mcpSecrets(service)))).not.toContain(key)
    const retained = mcpWriteInput((await restored.list(actor))[0]!)
    await expect(restored.save(actor, { ...retained, run: { ...retained.run!, prepareCommand: 'echo ' + key } })).rejects.toMatchObject({
      code: 'mcp-service-invalid',
    })
    await expect(restored.save(actor, { ...retained, clearCredential: true, run: { ...retained.run!, location: 'member' } })).rejects.toMatchObject({
      code: 'mcp-service-invalid',
    })
    await restored.save(actor, { ...retained, name: 'p-renamed-history', description: 'Updated', credential: 'fictional-another-key' }, false, service.name)
    expect(JSON.stringify(await restored.list(actor))).not.toContain(key)
    const replacement = mcpWriteInput((await restored.list(actor))[0]!)
    await restored.save(actor, { ...replacement, run: { ...replacement.run!, args: ['ordinary.js'] }, retainedArguments: [] })
    expect(mcpSecrets((await reopened.read()).services[0]!)).not.toContain(key)
    expect((await restored.list(actor))[0]?.run?.args).toEqual(['ordinary.js'])
  } finally {
    await store.close()
    await reopened.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps member environment rotation usable with protected arguments after reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-mcp-member-rotation-'))
  const database = await openTestDatabase(root),
    store = createMcpStorage(database),
    reopened = createMcpStorage(database)
  const key = 'fictional-original-member-environment',
    replacement = 'fictional-replacement-member-environment'
  try {
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    const accounts = new PostgresCommunityAccountStore(database),
      actor = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const management = new McpServices(accounts, store, { synchronize: async () => {} })
    await management.save(actor, {
      name: 'p-member-history',
      description: '',
      url: '',
      run: { location: 'member', command: 'node', args: ['--key=' + key], env: [{ name: 'KEY', value: key }] },
    })
    const draft = mcpWriteInput((await management.list(actor))[0]!)
    await management.save(actor, { ...draft, run: { ...draft.run!, env: [{ name: 'KEY', value: replacement }] } })
    await reopened.initialize()
    const service = (await reopened.read()).services[0]!,
      restored = new McpServices(accounts, reopened, { synchronize: async () => {} })
    expect(service.run).toMatchObject({ location: 'member', args: ['--key=' + key], env: [{ name: 'KEY', value: replacement }] })
    expect(() => validateMcpSettings(service)).not.toThrow()
    expect(mcpSecrets(service)).toEqual(expect.arrayContaining([key, replacement]))
    const metadata =
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.mcp_services')) +
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.mcp_secrets'))
    const view = JSON.stringify(await restored.list(actor))
    for (const secret of [key, replacement]) {
      expect(metadata).not.toContain(secret)
      expect(view).not.toContain(secret)
    }
    await restored.save(actor, {
      ...mcpWriteInput((await restored.list(actor))[0]!),
      run: { ...service.run!, args: ['ordinary.js'], env: [] },
      retainedArguments: [],
    })
    expect(mcpSecrets((await reopened.read()).services[0]!)).not.toContain(key)
  } finally {
    await store.close()
    await reopened.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('rejects moving a shared credential retained in the environment into a member process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-mcp-shared-member-alias-'))
  const database = await openTestDatabase(root),
    store = createMcpStorage(database)
  const key = 'fictional-shared-credential-environment-alias'
  try {
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    const accounts = new PostgresCommunityAccountStore(database),
      actor = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const management = new McpServices(accounts, store, { synchronize: async () => {} })
    await management.save(actor, {
      name: 'p-shared-alias',
      description: '',
      url: '',
      credential: key,
      run: { location: 'shared', command: 'node', args: ['ordinary.js'], env: [{ name: 'KEY', value: key }] },
    })
    const draft = mcpWriteInput((await management.list(actor))[0]!)
    await expect(management.save(actor, { ...draft, clearCredential: true, run: { ...draft.run!, location: 'member' } })).rejects.toMatchObject({
      code: 'mcp-service-invalid',
    })
    expect((await store.read()).services[0]?.run?.location).toBe('shared')
  } finally {
    await store.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})

it('allows an ordinary shared process environment when switching to member after clearing credentials', () => {
  const previous = {
    name: 'p-mode-switch',
    description: '',
    url: '',
    generation: 1,
    credential: 'fictional-shared-key',
    run: { location: 'shared' as const, command: 'node', args: ['server.js'], env: [{ name: 'MODE', value: 'development' }] },
  }
  const draft = mcpWriteInput(mcpSettings(previous))
  expect(mergeMcpInput({ ...draft, clearCredential: true, run: { ...draft.run!, location: 'member' } }, previous).run).toMatchObject({
    location: 'member',
    env: [{ name: 'MODE', value: 'development' }],
  })
})

it('retains cleared platform credential provenance through an environment alias and reopening', async () => {
  const root = await mkdtemp(join(tmpdir(), 'postgres-mcp-platform-alias-history-'))
  const database = await openTestDatabase(root),
    store = createMcpStorage(database),
    reopened = createMcpStorage(database)
  const key = 'fictional-former-platform-credential'
  try {
    await seedMcpParents(database, { groups: ['team'] })
    await store.initialize()
    const accounts = new PostgresCommunityAccountStore(database),
      actor = await accounts.createFirstAdmin({ username: 'admin', email: '', password: 'password' })
    const management = new McpServices(accounts, store, { synchronize: async () => {} })
    await management.save(actor, {
      name: 'p-platform-alias',
      description: '',
      url: '',
      credential: key,
      run: { location: 'shared', command: 'node', args: ['server.js'], env: [{ name: 'KEY', value: key }] },
    })
    await management.save(actor, { ...mcpWriteInput((await management.list(actor))[0]!), clearCredential: true })
    await reopened.initialize()
    const restored = new McpServices(accounts, reopened, { synchronize: async () => {} }),
      draft = mcpWriteInput((await restored.list(actor))[0]!)
    await expect(restored.save(actor, { ...draft, run: { ...draft.run!, location: 'member' } })).rejects.toMatchObject({ code: 'mcp-service-invalid' })
    const metadata =
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.mcp_services')) +
      JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.mcp_secrets'))
    expect(metadata).not.toContain(key)
    await restored.save(actor, { ...draft, run: { ...draft.run!, env: [] } })
    const cleared = mcpWriteInput((await restored.list(actor))[0]!)
    await restored.save(actor, { ...cleared, run: { ...cleared.run!, location: 'member' } })
    expect((await reopened.read()).services[0]?.run?.location).toBe('member')
    expect(mcpSecrets((await reopened.read()).services[0]!)).not.toContain(key)
  } finally {
    await store.close()
    await reopened.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
})
