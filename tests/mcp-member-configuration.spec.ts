import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { mcpWriteInput } from '../src/domain/mcp-service.js'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { PostgresCommunityAccountStore } from '../src/adapters/postgres-community-accounts.js'
import { createMcpStorage } from '../src/composition/mcp-storage.js'
import { FileMcpProjection } from '../src/adapters/mcp-projection.js'
import { McpHttpWire } from '../src/adapters/mcp-wire.js'
import { NodePluginUpstreamTransport } from '../src/adapters/plugin-upstream-transport.js'
import { McpServices } from '../src/use-cases/mcp-services.js'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
import { createMcpGateway } from '../src/inbound/mcp-gateway.js'
import { openTestDatabase, openTestModelAccess } from './support/community-application.js'

async function fixture(run: (value: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-member-configuration-'))
  const database = await openTestDatabase(root),
    tokens = await openTestModelAccess(root),
    store = createMcpStorage(database)
  let server: Server | undefined
  async function setup() {
    await store.initialize()
    const accounts = new PostgresCommunityAccountStore(database)
    const actor = await accounts.createFirstAdmin({ username: 'admin', password: 'password', email: '' })
    const member = await accounts.create({ username: 'member', password: 'password', email: '' })
    const token = await tokens.forUser(member.username, member.spaceId),
      adminToken = await tokens.forUser(actor.username, actor.spaceId)
    const projection = new FileMcpProjection({
      dataRoot: root,
      command: '/unused',
      args: [],
      defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
    })
    const services = new McpServices(accounts, store, projection, {
      ready: () => ({ directory: '/fixture/prepared', dependencies: [] }),
      view: () => ({ stage: 'ready', updatedAt: 0, log: '' }),
      changed: async () => {},
      restart() {},
    })
    const key = 'fictional-member-mcp-environment-key'
    await services.save(actor, {
      name: 'p-member',
      description: '',
      url: '',
      run: { location: 'member', command: 'node', args: ['server.js', '--key=' + key], env: [{ name: 'KEY', value: key }] },
    })
    await services.grant(actor, member.groupId, ['p-member'])
    const authority = new CommunityModelAuthorization(accounts, tokens)
    let beforeRegister: (() => Promise<void>) | undefined
    const authorization: Pick<CommunityModelAuthorization, 'authorize' | 'register'> = {
      authorize: authority.authorize.bind(authority),
      register: async (header, callback, identified) => {
        await beforeRegister?.()
        return await authority.register(header, callback, identified)
      },
    }
    const handle = createMcpGateway({
      authorization,
      services,
      wire: new McpHttpWire(),
      transport: new NodePluginUpstreamTransport('idle'),
      connections: { track() {}, untrack() {} },
    })
    server = createServer((request, response) => {
      void handle(request, response)
    })
    await new Promise<void>(resolve => {
      server!.listen(0, '127.0.0.1', resolve)
    })
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`
    const generation = (await store.read()).services[0]!.generation
    const get = (credential = token, version = generation, diagnostic = false) =>
      fetch(`${origin}/mcp-member${diagnostic ? '-test' : ''}/p-member?generation=${version}`, { headers: { authorization: `Bearer ${credential}` } })
    return {
      root,
      database,
      store,
      services,
      actor,
      member,
      key,
      token,
      adminToken,
      origin,
      generation,
      get,
      beforeRegister: (callback: () => Promise<void>) => {
        beforeRegister = callback
      },
    }
  }
  try {
    await run(await setup())
  } finally {
    server?.closeAllConnections()
    if (server)
      await new Promise<void>(resolve => {
        server!.close(() => resolve())
      })
    await store.close()
    await tokens.close()
    await database.close()
    await rm(root, { recursive: true, force: true })
  }
}

it('projects no member MCP values and supplies exact current launch settings only to authorized members', async () => {
  await fixture(async f => {
    const projection = await readFile(join(f.root, 'mcp/members', f.member.spaceId, 'entries.json'), 'utf8')
    expect(projection).not.toContain(f.key)
    expect(projection).not.toContain('server.js')
    expect(projection).toContain('generation=' + f.generation)
    const response = await f.get()
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toMatchObject({
      command: 'node',
      args: ['server.js', '--key=' + f.key],
      env: [{ name: 'KEY', value: f.key }],
      directory: '/fixture/prepared',
      disabledTools: [],
    })
    expect((await f.get(f.token, f.generation, true)).status).toBe(403)
    expect((await f.get(f.adminToken, f.generation, true)).status).toBe(200)
    expect((await f.get('unknown-token')).status).toBe(401)
    expect((await f.get(f.token, f.generation + 1)).status).toBe(404)
    await f.services.save(f.actor, {
      name: 'p-member',
      description: '',
      url: '',
      run: { location: 'member', command: 'node', args: ['next.js'], env: [{ name: 'KEY', value: 'fictional-new-member-key' }] },
    })
    expect((await f.get()).status).toBe(404)
    expect(await (await f.get(f.token, (await f.store.read()).services[0]!.generation)).json()).toMatchObject({
      args: ['next.js'],
      env: [{ name: 'KEY', value: 'fictional-new-member-key' }],
    })
    await f.services.grant(f.actor, f.member.groupId, [])
    expect((await f.get(f.token, (await f.store.read()).services[0]!.generation)).status).toBe(403)
  })
})

it.each(['grant', 'configuration', 'account'])('withholds member launch settings when %s changes during the final database admission', async change => {
  await fixture(async f => {
    let entered!: () => void, release!: () => void, unlock!: () => void
    const began = new Promise<void>(resolve => {
        entered = resolve
      }),
      gate = new Promise<void>(resolve => {
        release = resolve
      })
    f.beforeRegister(async () => {
      entered()
      await gate
    })
    const pending = f.get()
    let holder: Promise<void> | undefined
    try {
      await began
      let locked!: () => void
      const held = new Promise<void>(resolve => {
          locked = resolve
        }),
        lockGate = new Promise<void>(resolve => {
          unlock = resolve
        })
      holder = f.database.transaction(async sql => {
        await sql.query("SELECT username FROM dsh_phalanx.accounts WHERE username='member' FOR UPDATE")
        locked()
        await lockGate
        if (change === 'account') await sql.query("UPDATE dsh_phalanx.accounts SET disabled=true WHERE username='member'")
      })
      await held
      release()
      await expect
        .poll(async () =>
          Number(
            (
              await f.database.query<{ waiting: string }>(
                "SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
              )
            )[0]!.waiting,
          ),
        )
        .toBeGreaterThan(0)
      const state = await f.store.read()
      if (change === 'grant') await f.store.update(await f.store.read(), { ...state, grants: {} })
      if (change === 'configuration')
        await f.store.update(await f.store.read(), {
          ...state,
          services: state.services.map(service => ({ ...service, run: { ...service.run!, env: [{ name: 'KEY', value: 'fictional-replacement-key' }] } })),
        })
      unlock()
      await holder
      const response = await pending
      expect(response.status).toBe(403)
      expect(await response.text()).not.toContain(f.key)
    } finally {
      release()
      unlock?.()
      await holder
      await pending.catch(() => {})
    }
  })
})

it('masks retained member argument secrets through the authenticated launch endpoint after environment rotation', async () => {
  await fixture(async f => {
    const replacement = 'fictional-rotated-member-environment',
      script = join(f.root, 'echo-history.mjs')
    await writeFile(
      script,
      `import {createInterface} from 'node:readline';
const key=process.argv[2].slice('--key='.length);process.stderr.write(key.slice(0,11));setImmediate(()=>process.stderr.write(key.slice(11)));
for await(const line of createInterface({input:process.stdin})){const request=JSON.parse(line);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{content:[{type:'text',text:key+' '+process.env.KEY}]}})+'\\n');}`,
    )
    const draft = mcpWriteInput((await f.services.list(f.actor))[0]!)
    await f.services.save(f.actor, {
      ...draft,
      run: { ...draft.run!, command: process.execPath, args: [script, ''], env: [{ name: 'KEY', value: replacement }] },
    })
    const reopened = createMcpStorage(f.database)
    try {
      await reopened.initialize()
      expect((await reopened.read()).services[0]?.run?.args).toEqual([script, '--key=' + f.key])
    } finally {
      await reopened.close()
    }
    const directory = join(f.root, 'mcp/members', f.member.spaceId)
    for (const name of ['filter.mjs', 'entries.json', 'overlay.json', 'watch.mjs']) {
      const text = await readFile(join(directory, name), 'utf8')
      for (const secret of [f.key, replacement]) expect(text).not.toContain(secret)
    }
    const generation = (await f.store.read()).services[0]!.generation
    const reference = JSON.stringify({ path: '/mcp-member/p-member?generation=' + generation })
    const child = spawn(process.execPath, [join(directory, 'filter.mjs'), reference], {
      env: { ...process.env, DSH_PHALANX_MODEL_GATEWAY_URL: f.origin, DSH_PHALANX_MODEL_GATEWAY_ACCESS_TOKEN: f.token },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const exited = once(child, 'close'),
      lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]()
    let errors = ''
    child.stderr.on('data', chunk => {
      errors += chunk.toString()
    })
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo' } }) + '\n')
      const output = (await lines.next()).value!
      child.stdin.end()
      expect((await exited)[0]).toBe(0)
      expect({ response: JSON.parse(output), errors }).toMatchObject({
        response: { result: { content: [{ text: '[redacted] [redacted]' }] } },
        errors: '[redacted]',
      })
      for (const secret of [f.key, replacement]) {
        expect(output).not.toContain(secret)
        expect(errors).not.toContain(secret)
      }
    } finally {
      child.kill('SIGKILL')
      await exited
    }
  })
})

it('limits member launch masks to secrets referenced by the active process, excluding unrelated fields and candidates', async () => {
  await fixture(async f => {
    const privateHeader = 'fictional-unused-header-credential',
      candidateKey = 'fictional-unpublished-candidate-credential'
    const state = await f.store.read()
    await f.store.update(await f.store.read(), {
      ...state,
      services: state.services.map(service => ({
        ...service,
        headers: [{ name: 'X-Private', value: privateHeader }],
        catalogUpdate: {
          name: 'p-candidate',
          requestId: 'request',
          version: '2',
          baseGeneration: service.generation,
          actor: f.actor,
          status: 'testing',
          candidate: {
            name: 'p-candidate',
            description: '',
            url: 'https://candidate.example.test',
            generation: service.generation + 1,
            credential: candidateKey,
          },
        },
      })),
    })
    const response = await f.get(),
      configuration = await response.json()
    expect(response.status).toBe(200)
    expect(configuration.secretValues).toEqual([f.key])
    for (const secret of [privateHeader, candidateKey]) expect(JSON.stringify(configuration)).not.toContain(secret)
  })
})
