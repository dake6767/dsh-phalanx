import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CommunityAccountStore } from '../src/adapters/community-account-store.js'
import { FileCommunityModelAccess } from '../src/adapters/community-model-access.js'
import { FileMcpStore } from '../src/adapters/mcp-store.js'
import { FileExpertStore } from '../src/adapters/expert-store.js'
import { FileRuntimeDependencyStore } from '../src/adapters/runtime-dependency-store.js'
import { McpHttpWire } from '../src/adapters/mcp-wire.js'
import { NodePluginUpstreamTransport } from '../src/adapters/plugin-upstream-transport.js'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
import { McpServices } from '../src/use-cases/mcp-services.js'
import { Experts } from '../src/use-cases/experts.js'
import { RuntimeDependencies } from '../src/use-cases/runtime-dependencies.js'
import { McpRuntimeDependencies } from '../src/use-cases/mcp-runtime-dependencies.js'
import { createMcpGateway } from '../src/inbound/mcp-gateway.js'

it.each(['grant', 'expert', 'dependency', 'account'])('invalidates a live MCP admission after a real %s store commits', async source => {
  const root = await mkdtemp(join(tmpdir(), 'mcp-authorization-versions-')), servers: Server[] = []
  const accounts = new CommunityAccountStore(join(root, 'accounts.db'))
  let send!: (text: string) => void, resolutions = 0
  const listen = async (server: Server) => {
    servers.push(server); await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address(); if (!address || typeof address === 'string') throw Error('No listener')
    return `http://127.0.0.1:${address.port}`
  }
  try {
    const member = await accounts.create({ username: 'member', password: 'password', email: '' })
    const access = new FileCommunityModelAccess(join(root, 'tokens.json')), token = access.forUser('member', member.spaceId)
    const upstream = await listen(createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      send = text => { response.write(`data: {"jsonrpc":"2.0","method":"${text}"}\n\n`) }; send('first')
    }))
    const store = new FileMcpStore(join(root, 'mcp.json')), expertStore = new FileExpertStore(join(root, 'experts.json'))
    expertStore.write({ revision: 0, experts: [{ id: 'expert', revision: 1, published: false, name: 'Expert', description: 'Read docs', icon: '', persona: 'Read docs', skills: [], skillPacks: [], plugins: [], mcp: ['p-docs'], model: null, examples: [] }], grants: source === 'expert' ? { [member.groupId]: ['expert'] } : {}, selections: {} })
    const experts = new Experts(accounts, expertStore, { list: () => [] }, { list: () => [] }, () => 'expert')
    const dependencyStore = new FileRuntimeDependencyStore(join(root, 'dependencies.json'))
    const dependencies = new RuntimeDependencies(accounts, dependencyStore, { isolated: true, recover: async () => {}, identity: () => 'fixture', prepare: async () => { throw Error('No preparation expected') }, collect: async () => {} }, { now: () => 0 })
    if (source === 'dependency') dependencyStore.save({ name: 'fixture', prepareCommand: 'fixture', pathDirectories: ['bin'], source: 'manual', stage: 'ready', log: '', checks: [], updatedAt: 0,
      current: { id: 'a'.repeat(64), identity: 'fixture', directory: root, mountedPath: root, pathDirectories: ['bin'], commands: [], commandPaths: {}, bytes: 0, isolated: true, checks: [], log: '' } })
    const preparation = new McpRuntimeDependencies(store, dependencies)
    store.write({ services: [{ name: 'p-docs', generation: 1, description: '', url: source === 'dependency' ? '' : upstream,
      ...(source === 'dependency' ? { run: { location: 'shared' as const, command: 'fixture', args: [], env: [], runtimeDependencies: ['fixture'] } } : {}) }], grants: source === 'expert' ? {} : { [member.groupId]: ['p-docs'] }, revision: 1 })
    const services = new McpServices(accounts, store, { synchronize: async () => {} }, source === 'dependency' ? preparation : undefined, undefined, undefined, experts)
    const authorization = new CommunityModelAuthorization(accounts, { version: () => access.version(), resolve: value => { resolutions++; return access.resolve(value) } })
    const handle = createMcpGateway({ authorization, services, wire: new McpHttpWire(), transport: new NodePluginUpstreamTransport('idle'),
      shared: { connect: async () => ({ name: 'p-docs', baseUrl: upstream, credential: '', headers: [] }) }, connections: { track() {}, untrack() {} } })
    const origin = await listen(createServer((request, response) => { void handle(request, response) }))
    const response = await fetch(origin + '/mcp/p-docs', { headers: { authorization: `Bearer ${token}` } }), reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('first')
    send('second'); expect(new TextDecoder().decode((await reader.read()).value)).toContain('second')
    expect(resolutions).toBe(1)
    if (source === 'grant') store.write({ ...store.read(), grants: {} })
    if (source === 'expert') expertStore.write({ ...expertStore.read(), grants: {} })
    if (source === 'dependency') dependencyStore.remove('fixture')
    if (source === 'account') await accounts.setDisabled('member', true)
    send('revoked'); await expect(reader.read()).rejects.toThrow()
  } finally {
    for (const server of servers.reverse()) { server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()) }) }
    accounts.close(); await rm(root, { recursive: true, force: true })
  }
})
