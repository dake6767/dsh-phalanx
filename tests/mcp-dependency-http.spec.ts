import { chmod, lstat, mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { readBootstrapCredential } from '../src/adapters/bootstrap-credential.js'
import { PlatformProcessHost } from '../src/adapters/platform-process-host.js'
import { mcpWriteInput } from '../src/domain/mcp-service.js'
import { removeCommunityFixture } from './fixtures/owned-cleanup.js'
import { createCommunityApplication } from './support/community-application.js'

// These public-entry tests exercise the host-process adapter on every CI host.
beforeEach(() => {
  vi.spyOn(PlatformProcessHost.prototype, 'detect').mockResolvedValue()
})
afterEach(() => {
  vi.restoreAllMocks()
})

it('uses shared runtime dependencies through MCP administration and rotates runtime credentials without preparing again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-dependency-http-'))
  const app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'mcp-dependency-fixture-secret-32',
    runtime: {
      command: '/unavailable',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
    },
  })
  try {
    const origin = await app.start()
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
    const post = (path: string, body: unknown) =>
      fetch(origin + '/admin/api/' + path, { method: 'POST', headers: { cookie, origin, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const get = async (path: string) => (await fetch(origin + '/admin/api/' + path, { headers: { cookie } })).json()
    const script = `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return;const result=m.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[{name:process.env.KEY==='first'?'tool_one':'tool_two',inputSchema:{type:'object'}}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')})`
    const prepareCommand = `test -z "$KEY" && node -e 'require("fs").writeFileSync("server.cjs",Buffer.from("${Buffer.from(script).toString('base64')}","base64"))'`
    expect(
      (
        await post('mcp', {
          action: 'save',
          service: {
            name: 'p-search',
            description: '',
            url: '',
            credential: 'first',
            run: { location: 'shared', command: 'node', args: ['{dependencies}/server.cjs'], env: [{ name: 'KEY', value: '{credential}' }], prepareCommand },
          },
        })
      ).status,
    ).toBe(200)
    await expect.poll(async () => (await get('mcp'))[0].preparation.stage, { timeout: 10_000 }).toBe('ready')
    const service = (await get('mcp'))[0],
      dependency = (await get('runtime-dependencies'))[0]
    expect(service.run).not.toHaveProperty('prepareCommand')
    expect(dependency.references).toEqual([{ kind: 'mcp', name: 'p-search' }])
    expect((await post('runtime-dependencies', { action: 'remove', name: dependency.name })).status).toBe(409)
    expect(await (await post('mcp/test', { name: service.name })).json()).toMatchObject({ testStatus: 'passed' })
    expect((await get('mcp'))[0].tools[0].name).toBe('tool_one')
    for (const credential of ['second', 'third', 'fourth']) {
      expect((await post('mcp', { action: 'save', service: { ...mcpWriteInput(service), credential } })).status).toBe(200)
      expect(await (await post('mcp/test', { name: service.name })).json()).toMatchObject({ testStatus: 'passed' })
      expect((await get('mcp'))[0].tools[0].name).toBe('tool_two')
      expect((await get('runtime-dependencies'))[0].current.id).toBe(dependency.current.id)
    }
  } finally {
    await app.stop()
    const writable = async (path: string): Promise<void> => {
      if ((await lstat(path)).isDirectory()) {
        await chmod(path, 0o700)
        for (const name of await readdir(path)) await writable(join(path, name))
      }
    }
    await writable(root)
    await removeCommunityFixture(root)
  }
})

it('reports a failed chained MCP preparation without publishing its generated launcher', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-preparation-failure-'))
  const app = createCommunityApplication({
    listen: { host: '127.0.0.1', port: 0 },
    sessionSecret: 'mcp-failure-fixture-secret-32-bytes',
    runtime: {
      command: '/unavailable',
      args: [],
      dataRoot: root,
      defaultModel: { provider: 'deepseek-official', model: 'fixture', upstream: { baseUrl: 'https://example.test' } },
    },
  })
  try {
    const origin = await app.start()
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
    const get = async (path: string) => (await fetch(origin + '/admin/api/' + path, { headers: { cookie } })).json()
    const response = await fetch(origin + '/admin/api/mcp', {
      method: 'POST',
      headers: { cookie, origin, 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'save',
        service: {
          name: 'p-broken',
          description: '',
          url: '',
          run: {
            location: 'shared',
            command: 'node',
            args: ['missing.cjs'],
            env: [],
            prepareCommand: "printf 'PREPARATION_FAILED\\n'; false && printf 'unreachable\\n'",
          },
        },
      }),
    })
    expect(response.status).toBe(200)
    await expect.poll(async () => (await get('mcp'))[0].preparation.stage, { timeout: 10_000 }).toMatch(/^(ready|failed)$/u)
    expect((await get('mcp'))[0].preparation.stage).toBe('failed')
    const dependency = (await get('runtime-dependencies'))[0]
    expect(dependency).toMatchObject({ stage: 'failed', failureCode: 'prepare-failed' })
    expect(dependency.current).toBeUndefined()
    expect(dependency.log).toContain('PREPARATION_FAILED')
  } finally {
    await app.stop()
    const writable = async (path: string): Promise<void> => {
      if ((await lstat(path)).isDirectory()) {
        await chmod(path, 0o700)
        for (const name of await readdir(path)) await writable(join(path, name))
      }
    }
    await writable(root)
    await removeCommunityFixture(root)
  }
})
