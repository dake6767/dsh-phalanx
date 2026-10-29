import { asyncSkillFacts } from './fixtures/async-skill-facts.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { openTestAccounts, openTestDatabase, openTestModelAccess } from './support/community-application.js'
import { createMcpStorage } from '../src/composition/mcp-storage.js'
import { createExpertStorage } from '../src/composition/expert-storage.js'
import { cleanupOwned } from './fixtures/owned-cleanup.js'
import { createRuntimeStorage } from '../src/composition/runtime-storage.js'
import { McpHttpWire } from '../src/adapters/mcp-wire.js'
import { NodePluginUpstreamTransport } from '../src/adapters/plugin-upstream-transport.js'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
import { McpServices } from '../src/use-cases/mcp-services.js'
import { Experts } from '../src/use-cases/experts.js'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import { McpRuntimeDependencies } from '../src/use-cases/mcp-runtime-dependencies.js'
import { createMcpGateway } from '../src/inbound/mcp-gateway.js'

it.each(['grant', 'expert', 'dependency', 'account'])('invalidates a live MCP admission after a real %s store commits', async source => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-authorization-versions-')),
    servers: Server[] = []
  const database = await openTestDatabase(root),
    store = createMcpStorage(database),
    runtimeStorage = createRuntimeStorage(database),
    expertStore = createExpertStorage(database)
  await runtimeStorage.initialize()
  await store.initialize()
  await expertStore.initialize()
  const accounts = await openTestAccounts(root),
    access = await openTestModelAccess(root)
  let send!: (text: string) => void
  const listen = async (server: Server) => {
    servers.push(server)
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('No listener')
    return `http://127.0.0.1:${address.port}`
  }
  try {
    const member = await accounts.create({ username: 'member', password: 'password', email: '' })
    const token = await access.forUser('member', member.spaceId)
    const upstream = await listen(
      createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        send = text => {
          response.write(`data: {"jsonrpc":"2.0","method":"${text}"}\n\n`)
        }
        send('first')
      }),
    )
    const expertSeed = {
      revision: 0,
      experts: [
        {
          id: 'expert',
          revision: 1,
          published: false,
          name: 'Expert',
          description: 'Read docs',
          icon: '',
          persona: 'Read docs',
          skills: [],
          skillPacks: [],
          plugins: [],
          mcp: ['p-docs'],
          model: null,
          examples: [],
        },
      ],
      grants: source === 'expert' ? { [member.groupId]: ['expert'] } : {},
      selections: {},
    }
    const experts = new Experts(accounts, expertStore, asyncSkillFacts({ list: () => [] }), asyncSkillFacts({ list: () => [] }), () => 'expert')
    const dependencyStore = runtimeStorage.store
    const dependencies = new RuntimeDependencies(
      accounts,
      dependencyStore,
      {
        isolated: true,
        recover: async () => {},
        identity: () => 'fixture',
        prepare: async () => {
          throw Error('No preparation expected')
        },
        collect: async () => {},
      },
      { now: () => 0 },
    )
    if (source === 'dependency')
      await dependencyStore.save({
        name: 'fixture',
        prepareCommand: 'fixture',
        pathDirectories: ['bin'],
        source: 'manual',
        stage: 'ready',
        log: '',
        checks: [],
        updatedAt: 0,
        current: {
          id: 'a'.repeat(64),
          identity: 'fixture',
          directory: root,
          mountedPath: root,
          pathDirectories: ['bin'],
          commands: [],
          commandPaths: {},
          bytes: 0,
          isolated: true,
          checks: [],
          log: '',
        },
      })
    const preparation = new McpRuntimeDependencies(store, dependencies)
    await store.update(await store.read(), {
      services: [
        {
          name: 'p-docs',
          generation: 1,
          description: '',
          url: source === 'dependency' ? '' : upstream,
          ...(source === 'dependency' ? { run: { location: 'shared' as const, command: 'fixture', args: [], env: [], runtimeDependencies: ['fixture'] } } : {}),
        },
      ],
      grants: source === 'expert' ? {} : { [member.groupId]: ['p-docs'] },
      revision: 1,
    })
    await expertStore.update(await expertStore.read(), expertSeed)
    const services = new McpServices(
      accounts,
      store,
      { synchronize: async () => {} },
      source === 'dependency' ? preparation : undefined,
      undefined,
      undefined,
      experts,
    )
    const authorization = new CommunityModelAuthorization(accounts, { resolve: value => access.resolve(value) })
    const handle = createMcpGateway({
      authorization,
      services,
      wire: new McpHttpWire(),
      transport: new NodePluginUpstreamTransport('idle'),
      shared: { connect: async () => ({ name: 'p-docs', baseUrl: upstream, credential: '', headers: [] }) },
      connections: { track() {}, untrack() {} },
    })
    const origin = await listen(
      createServer((request, response) => {
        void handle(request, response)
      }),
    )
    const response = await fetch(origin + '/mcp/p-docs', { headers: { authorization: `Bearer ${token}` } }),
      reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('first')
    send('second')
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('second')
    if (source === 'grant') await store.update(await store.read(), { ...(await store.read()), grants: {} })
    if (source === 'expert') {
      const snapshot = await expertStore.read()
      await expertStore.update(snapshot, { ...snapshot, grants: {} })
    }
    if (source === 'dependency') {
      const { current, ...unavailable } = (await dependencyStore.list())[0]!
      void current
      await dependencyStore.save({ ...unavailable, stage: 'failed' })
    }
    if (source === 'account') await accounts.setDisabled('member', true)
    send('revoked')
    await expect(reader.read()).rejects.toThrow()
  } finally {
    await cleanupOwned(
      ...servers.reverse().map(server => async () => {
        server.closeAllConnections()
        await new Promise(resolve => server.close(resolve))
      }),
      () => access.close(),
      () => accounts.close(),
      () => expertStore.close(),
      () => store.close(),
      () => runtimeStorage.close(),
      () => database.close(),
      () => rm(root, { recursive: true, force: true }),
    )
  }
})

it.each(['grant', 'expert', 'dependency', 'account', 'disabled-tool', 'upstream', 'unversioned'])(
  'does not forward an MCP call after %s changes during final account registration',
  async change => {
    const root = await mkdtemp(join(tmpdir(), 'mcp-final-admission-')),
      servers: Server[] = []
    const database = await openTestDatabase(root),
      accounts = new PostgresCommunityAccountStore(database),
      tokens = await openTestModelAccess(root),
      store = createMcpStorage(database),
      runtimeStorage = createRuntimeStorage(database),
      expertStore = createExpertStorage(database)
    await runtimeStorage.initialize()
    await store.initialize()
    await expertStore.initialize()
    let entered!: () => void,
      release!: () => void,
      commitDisable: (() => void) | undefined,
      disabling: Promise<void> | undefined,
      forwarded = 0,
      registered = 0
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    const listen = async (server: Server) => {
      servers.push(server)
      await new Promise<void>(resolve => {
        server.listen(0, '127.0.0.1', resolve)
      })
      return `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    }
    try {
      const member = await accounts.create({ username: 'member', password: 'password', email: '' })
      const upstream = await listen(
        createServer((_request, response) => {
          forwarded++
          response.setHeader('content-type', 'application/json')
          response.end('{"jsonrpc":"2.0","id":1,"result":{}}')
        }),
      )
      const token = await tokens.forUser('member', member.spaceId)
      const expertSeed = {
        revision: 0,
        experts: [
          {
            id: 'expert',
            revision: 1,
            published: false,
            name: 'Expert',
            description: 'Read docs',
            icon: '',
            persona: 'Read docs',
            skills: [],
            skillPacks: [],
            plugins: [],
            mcp: ['p-docs'],
            model: null,
            examples: [],
          },
        ],
        grants: change === 'expert' ? { [member.groupId]: ['expert'] } : {},
        selections: {},
      }
      const experts = new Experts(accounts, expertStore, asyncSkillFacts({ list: () => [] }), asyncSkillFacts({ list: () => [] }), () => 'expert')
      const dependencyStore = runtimeStorage.store
      const dependencies = new RuntimeDependencies(
        accounts,
        dependencyStore,
        {
          isolated: true,
          recover: async () => {},
          identity: () => 'fixture',
          prepare: async () => {
            throw Error('No preparation expected')
          },
          collect: async () => {},
        },
        { now: () => 0 },
      )
      if (change === 'dependency')
        await dependencyStore.save({
          name: 'fixture',
          prepareCommand: 'fixture',
          pathDirectories: ['bin'],
          source: 'manual',
          stage: 'ready',
          log: '',
          checks: [],
          updatedAt: 0,
          current: {
            id: 'a'.repeat(64),
            identity: 'fixture',
            directory: root,
            mountedPath: root,
            pathDirectories: ['bin'],
            commands: [],
            commandPaths: {},
            bytes: 0,
            isolated: true,
            checks: [],
            log: '',
          },
        })
      await store.update(await store.read(), {
        services: [
          {
            name: 'p-docs',
            generation: 1,
            description: '',
            url: change === 'dependency' ? '' : upstream,
            ...(change === 'dependency'
              ? { run: { location: 'shared' as const, command: 'fixture', args: [], env: [], runtimeDependencies: ['fixture'] } }
              : {}),
          },
        ],
        grants: change === 'expert' ? {} : { [member.groupId]: ['p-docs'] },
        revision: 1,
      })
      const unknownRuntime = { ready: () => undefined, view: () => undefined, changed: async () => {}, restart() {}, version: () => undefined }
      await expertStore.update(await expertStore.read(), expertSeed)
      const services = new McpServices(
        accounts,
        store,
        { synchronize: async () => {} },
        change === 'dependency' ? new McpRuntimeDependencies(store, dependencies) : change === 'unversioned' ? unknownRuntime : undefined,
        undefined,
        undefined,
        experts,
      )
      const authority = new CommunityModelAuthorization(accounts, tokens)
      const register: CommunityModelAuthorization['register'] = async (header, callback, identified) => {
        entered()
        await gate
        return await authority.register(header, callback, identified)
      }
      const handle = createMcpGateway({
        authorization: { authorize: authority.authorize.bind(authority), register },
        services,
        wire: new McpHttpWire(),
        transport: new NodePluginUpstreamTransport('idle'),
        shared: { connect: async () => ({ name: 'p-docs', baseUrl: upstream, credential: '', headers: [] }) },
        connections: {
          track() {
            registered++
          },
          untrack() {},
        },
      })
      const origin = await listen(
        createServer((request, response) => {
          void handle(request, response)
        }),
      )
      const pending = fetch(origin + '/mcp/p-docs', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write' } }),
      })
      await began
      if (change === 'grant' || change === 'unversioned') await store.update(await store.read(), { ...(await store.read()), grants: {} })
      if (change === 'expert') {
        const snapshot = await expertStore.read()
        await expertStore.update(snapshot, { ...snapshot, grants: {} })
      }
      if (change === 'dependency') {
        const { current, ...unavailable } = (await dependencyStore.list())[0]!
        void current
        await dependencyStore.save({ ...unavailable, stage: 'failed' })
      }
      if (change === 'account') {
        let locked!: () => void
        const holding = new Promise<void>(resolve => {
            locked = resolve
          }),
          commit = new Promise<void>(resolve => {
            commitDisable = resolve
          })
        disabling = database.transaction(async sql => {
          await sql.query("UPDATE dsh_phalanx.accounts SET disabled=true,session_epoch=1 WHERE username='member'")
          locked()
          await commit
        })
        await holding
      }
      if (change === 'disabled-tool')
        await store.update(await store.read(), {
          ...(await store.read()),
          services: (await store.read()).services.map(row => ({ ...row, disabledTools: ['write'], generation: row.generation + 1 })),
        })
      if (change === 'upstream')
        await store.update(await store.read(), {
          ...(await store.read()),
          services: (await store.read()).services.map(row => ({
            ...row,
            url: upstream + '/new',
            credential: 'rotated-fixture',
            generation: row.generation + 1,
          })),
        })
      release()
      if (disabling) {
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
        commitDisable!()
        await disabling
      }
      const response = await pending
      await response.text()
      expect(response.status).not.toBe(200)
      expect(forwarded).toBe(0)
      expect(registered).toBe(0)
    } finally {
      release()
      commitDisable?.()
      await cleanupOwned(
        async () => {
          await disabling
        },
        ...servers.reverse().map(server => async () => {
          server.closeAllConnections()
          await new Promise(resolve => server.close(resolve))
        }),
        () => tokens.close(),
        () => expertStore.close(),
        () => store.close(),
        () => runtimeStorage.close(),
        () => database.close(),
        () => rm(root, { recursive: true, force: true }),
      )
    }
  },
)
