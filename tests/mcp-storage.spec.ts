import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { FileMcpProjection } from '../src/adapters/mcp-projection.js'
import { createMcpStorage } from '../src/composition/mcp-storage.js'
import { seedMcpParents } from './fixtures/mcp-parents.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication, openTestDatabase } from './support/community-application.js'
it('persists library/grants together and projects only per-member names and gateway access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-state-'))
  const database = await openTestDatabase(root),
    store = createMcpStorage(database)
  await seedMcpParents(database, { groups: ['team', 'members'] })
  await store.initialize()
  try {
    const services = [{ name: 'p-docs', generation: 1, description: 'Team docs', url: 'https://private-upstream.example.test/mcp' }]
    await store.update(await store.read(), { services, grants: { team: ['p-docs'] } })
    const reopened = createMcpStorage(database)
    await reopened.initialize()
    expect(await reopened.read()).toMatchObject({ services, grants: { team: ['p-docs'] } })
    const config = {
      dataRoot: root,
      command: '/unused',
      args: [],
      defaultModel: { provider: 'deepseek-official' as const, model: 'test', upstream: { baseUrl: 'https://model.example.test' } },
      container: { runtime: 'podman' as const, image: 'fixture', internalPort: 4180, gatewayPort: 3081 },
    }
    const projection = new FileMcpProjection(config)
    await projection.synchronize([
      { username: 'member', spaceId: 'first', services },
      { username: 'other', spaceId: 'second', services: [] },
    ])
    const read = (id: string) => readFile(join(root, 'mcp', 'members', id, 'entries.json'), 'utf8')
    const contents = await read('first')
    expect(contents).toContain('/mcp/p-docs')
    expect(contents).not.toContain('private-upstream')
    expect(contents).not.toContain('Team docs')
    expect(JSON.parse(await read('second'))).toEqual([])
    await projection.synchronize([{ username: 'member', spaceId: 'first', services: [] }])
    expect(JSON.parse(await read('first'))).toEqual([])
  } finally {
    await store.close()
    await database.close()
    await removeCommunityFixture(root)
  }
})
it('preserves adopted preset state and retired import identities across durable reloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-catalog-store-'))
  const database = await openTestDatabase(root),
    store = createMcpStorage(database)
  await seedMcpParents(database, { groups: ['team', 'members'] })
  await store.initialize()
  try {
    await store.update(await store.read(), {
      services: [
        {
          name: 'p-map',
          generation: 1,
          description: 'Amap',
          url: 'https://mcp.amap.com/mcp',
          credential: 'fixture-secret',
          catalogRequestId: 'request-0000000001',
          catalog: { id: 'amap', version: '1', status: 'failed' },
        },
      ],
      grants: {},
      catalogRequests: ['request-0000000001', 'removed-000000001'],
    })
    const reopened = createMcpStorage(database)
    await reopened.initialize()
    const restored = await reopened.read()
    expect(restored.services[0]).toMatchObject({ catalogRequestId: 'request-0000000001', catalog: { id: 'amap', version: '1', status: 'failed' } })
    expect(restored.catalogRequests).toEqual(['request-0000000001', 'removed-000000001'])
  } finally {
    await store.close()
    await database.close()
    await removeCommunityFixture(root)
  }
})

it('reloads a private candidate and its operation receipt without replacing the active service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-update-store-'))
  const database = await openTestDatabase(root),
    store = createMcpStorage(database)
  await seedMcpParents(database, { groups: ['team', 'members'] })
  await store.initialize()
  try {
    const candidate = {
      name: 'p-update-2',
      preparationName: 'p-update-2',
      generation: 2,
      description: 'Next',
      url: 'https://new.example.test',
      credential: 'fixture-private',
      catalog: { id: 'amap', version: '2', status: 'testing' as const },
    }
    await store.update(await store.read(), {
      revision: 2,
      services: [
        {
          name: 'p-map',
          generation: 1,
          description: 'Current',
          url: 'https://old.example.test',
          catalog: { id: 'amap', version: '1', status: 'ready' },
          catalogUpdate: {
            name: candidate.name,
            requestId: 'durable-update-request',
            version: '2',
            baseGeneration: 1,
            actor: { username: 'admin', spaceId: 'admin', sessionEpoch: 0 },
            status: 'testing',
            candidate,
          },
        },
      ],
      grants: { members: ['p-map'] },
      catalogRequests: ['durable-update-request'],
    })
    const reopened = createMcpStorage(database)
    await reopened.initialize()
    expect(await reopened.read()).toMatchObject({
      revision: 2,
      services: [{ url: 'https://old.example.test', catalogUpdate: { candidate } }],
      grants: { members: ['p-map'] },
      catalogRequests: ['durable-update-request'],
    })
  } finally {
    await store.close()
    await database.close()
    await removeCommunityFixture(root)
  }
})

it('lets the platform own shared-call deadlines without changing remote or member client deadlines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-deadline-'))
  try {
    const { executionLimits, DEFAULT_EXECUTION_LIMITS } = await import('../src/domain/execution-control.js')
    const longest = executionLimits({ ...DEFAULT_EXECUTION_LIMITS, timeoutSeconds: 3600 })
    const config = {
      dataRoot: root,
      command: '/unused',
      args: [],
      defaultModel: { provider: 'deepseek-official' as const, model: 'test', upstream: { baseUrl: 'https://model.example.test' } },
    }
    const service = {
      name: 'p-shared',
      generation: 1,
      description: '',
      url: '',
      run: { location: 'shared' as const, command: 'node', args: ['server.mjs'], env: [], prepareCommand: '' },
    }
    const member = { ...service, name: 'p-member', run: { ...service.run, location: 'member' as const }, prepared: { directory: '/fixture/prepared' } }
    await new FileMcpProjection(config).synchronize([
      {
        username: 'member',
        spaceId: 'first',
        services: [service, member, { name: 'p-remote', generation: 1, description: '', url: 'https://example.test/mcp' }],
      },
    ])
    const entries = JSON.parse(await readFile(join(root, 'mcp', 'members', 'first', 'entries.json'), 'utf8'))
    // The official client's 60-second default would cancel a silent call before
    // even the platform's default 120-second deadline. Its safety ceiling must
    // allow every supported platform deadline to report its own result first.
    expect(entries[0].config.toolCallTimeoutMs).toBeGreaterThan(longest.timeoutSeconds * 1000)
    expect(entries[0].config.toolCallTimeoutMs).toBeLessThanOrEqual(longest.timeoutSeconds * 1000 + 30000)
    expect(entries[1].config.toolCallTimeoutMs).toBeUndefined()
    expect(entries[2].config.toolCallTimeoutMs).toBeUndefined()
  } finally {
    await removeCommunityFixture(root)
  }
})

it('changes its cheap authorization version for grant-only and preference-only commits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-version-'))
  const database = await openTestDatabase(root),
    store = createMcpStorage(database)
  await seedMcpParents(database, { groups: ['team', 'members'] })
  await store.initialize()
  try {
    await seedMcpParents(database, { spaces: ['space'] })
    await store.update(await store.read(), {
      services: [{ name: 'p-docs', generation: 0, description: '', url: 'https://docs.example.test' }],
      grants: {},
      revision: 0,
    })
    const initial = store.view.version(),
      library = await store.read()
    await store.update(library, { ...library, grants: { team: [] } })
    const granted = store.view.version()
    expect(granted).not.toBe(initial)
    const current = await store.read()
    await store.update(current, { ...current, preferences: { space: { 'p-docs': false } } })
    expect(store.view.version()).not.toBe(granted)
    expect((await store.read()).revision).toBe(0)
  } finally {
    await store.close()
    await database.close()
    await removeCommunityFixture(root)
  }
})

it('saves MCP through the application in PostgreSQL and reopens without a JSON secret backend', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-application-'))
  const make = () =>
    createCommunityApplication({
      listen: { host: '127.0.0.1', port: 0 },
      runtime: {
        command: '/unavailable-dsh',
        args: [],
        dataRoot: root,
        defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
      },
    })
  let application = make()
  try {
    let origin = await application.start()
    const bootstrap = await fetch(origin + '/bootstrap', {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ credential: readBootstrapCredential(root)!.credential, username: 'admin', password: 'password' }),
    })
    const cookie = bootstrap.headers
      .getSetCookie()
      .map(value => value.split(';')[0])
      .join('; ')
    const service = { name: 'p-service', description: '', url: 'https://upstream.example.test', credential: 'fictional-mcp-http-key' }
    const response = await fetch(origin + '/admin/api/mcp', {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', service }),
    })
    expect(response.status).toBe(200)
    const saved = await response.json()
    expect(JSON.stringify(saved)).not.toContain(service.credential)
    expect(await readdir(join(root, 'mcp'))).not.toContain('library.json')
    const database = await openTestDatabase(root)
    try {
      const rows = JSON.stringify(await database.query('SELECT * FROM dsh_phalanx.mcp_secrets'))
      expect(rows).toContain('ciphertext')
      expect(rows).not.toContain(service.credential)
    } finally {
      await database.close()
    }
    await application.stop()
    application = make()
    origin = await application.start()
    expect(await (await fetch(origin + '/admin/api/mcp', { headers: { cookie } })).json()).toEqual(saved)
  } finally {
    await application.stop()
    await removeCommunityFixture(root)
  }
})
