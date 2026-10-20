import { McpHttpWire } from '../src/adapters/mcp-wire.js'
import { createServer, request as httpRequest, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import { createMcpGateway } from '../src/inbound/mcp-gateway.js'
import { NodePluginUpstreamTransport } from '../src/adapters/plugin-upstream-transport.js'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
const servers: Server[] = []
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } })
async function listen(server: Server) { servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); if (!address || typeof address === 'string') throw Error('missing address'); return `http://127.0.0.1:${address.port}` }
it('admits expert-only MCP acquisition, rejects its immediate withdrawal and duplicate tokens, and preserves streaming', async () => {
  const received: { url: string | undefined, headers: import('node:http').IncomingHttpHeaders }[] = []
  let enabled = true, disabled = false, requests = 0, finish: (() => void) | undefined
  const upstream = await listen(createServer(async (req, res) => {
    requests++
    received.push({ url: req.url, headers: req.headers })
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"jsonrpc":"2.0","method":"first"}\n\n'); finish = () => res.end('data: {"jsonrpc":"2.0","method":"last"}\n\n'); return }
    let data = ''; for await (const chunk of req) data += chunk
    res.writeHead(200, { 'set-cookie': 'private=true', 'content-type': 'application/json' }); res.end(data)
  }))
  const authorization = new CommunityModelAuthorization({ getState: () => ({ username: 'member', spaceId: 'space', disabled, sessionEpoch: 0, admin: false, groupId: 'group' }) }, { resolve: token => token === 'member' ? { username: 'member', spaceId: 'space' } : undefined })
  const handle = createMcpGateway({ wire: new McpHttpWire(), authorization, services: { effective: () => [], accessible: () => enabled ? [{ name: 'p-docs', generation: 1, description: '', url: upstream + '/mcp/?scope=read' }] : [] }, transport: new NodePluginUpstreamTransport('idle'), connections: { track: () => {}, untrack: () => {} } })
  const origin = await listen(createServer((req, res) => { void handle(req, res) }))
  const send = () => new Promise<Response>((resolve, reject) => {
    const req = httpRequest(origin + '/mcp/p-docs', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer member', cookie: 'private', 'x-api-key': 'private', connection: 'x-forged', 'x-forged': 'private' } }, res => {
      const chunks: Buffer[] = []; res.on('data', chunk => chunks.push(chunk)); res.once('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode ?? 502, headers: Object.fromEntries(Object.entries(res.headers).map(([name, value]) => [name, String(value)])) })))
    }); req.once('error', reject); req.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
  })
  const response = await send(); expect(response.status).toBe(200); expect(response.headers.has('set-cookie')).toBe(false); expect(await response.json()).toMatchObject({ method: 'tools/list' })
  expect(received[0]?.url).toBe('/mcp/?scope=read')
  expect(received[0]?.headers).not.toHaveProperty('authorization')
  expect(received[0]?.headers).not.toHaveProperty('cookie')
  expect(received[0]?.headers).not.toHaveProperty('x-api-key')
  expect(received[0]?.headers).not.toHaveProperty('x-forged')
  enabled = false; expect((await send()).status).toBe(403); expect(requests).toBe(1)
  enabled = true; disabled = true; expect((await send()).status).toBe(403); disabled = false
  expect((await fetch(origin + '/mcp/p-docs')).status).toBe(401)
  const duplicate = await new Promise<number>(resolve => { const req = httpRequest(origin + '/mcp/p-docs', { headers: ['Host', new URL(origin).host, 'Authorization', 'Bearer member', 'Authorization', 'Bearer member'] }, res => { res.resume(); resolve(res.statusCode!) }); req.end() })
  expect(duplicate).toBe(401)
  const stream = await fetch(origin + '/mcp/p-docs', { headers: { authorization: 'Bearer member' } }); const reader = stream.body!.getReader()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('first'); finish!()
  expect(new TextDecoder().decode((await reader.read()).value)).toContain('last'); expect((await reader.read()).done).toBe(true)
})

it('routes shared MCP through the same gateway credential masking and disabled-tool policy', async () => {
  let forwarded = 0
  const upstream = await listen(createServer((_req, res) => {
    forwarded++; res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'read' }, { name: 'write' }], notice: 'fictional-shared-key' } }))
  }))
  const service = { name: 'p-shared', generation: 1, description: '', url: '', credential: 'fictional-shared-key', disabledTools: ['write'], run: { location: 'shared' as const, command: 'fixture', args: [], env: [], prepareCommand: '' } }
  const handle = createMcpGateway({ wire: new McpHttpWire(), authorization: { authorize: () => 'alice' }, services: { effective: () => [], accessible: () => [service] }, transport: new NodePluginUpstreamTransport('idle'), connections: { track() {}, untrack() {} }, shared: { connect: async () => ({ name: 'p-shared', baseUrl: upstream, credential: '', headers: [] }) } })
  const origin = await listen(createServer((req, res) => { void handle(req, res) }))
  const send = (method: string, params?: unknown) => fetch(origin + '/mcp/p-shared', { method: 'POST', headers: { authorization: 'Bearer member', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  expect(await (await send('tools/list')).json()).toMatchObject({ result: { tools: [{ name: 'read' }], notice: '[redacted]' } })
  expect(await (await send('tools/call', { name: 'write' })).json()).toHaveProperty('error'); expect(forwarded).toBe(1)
})

it('preserves an expired MCP HTTP session status without exposing an upstream error body', async () => {
  const upstream = await listen(createServer((_req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('private bridge error detail') }))
  const handle = createMcpGateway({ wire: new McpHttpWire(), authorization: { authorize: () => 'alice' }, services: { effective: () => [{ name: 'p-expired', description: '', url: upstream, generation: 1 }] }, transport: new NodePluginUpstreamTransport('idle'), connections: { track() {}, untrack() {} } })
  const origin = await listen(createServer((req, res) => { void handle(req, res) }))
  const response = await fetch(origin + '/mcp/p-expired', { headers: { authorization: 'Bearer member' } })
  expect(response.status).toBe(404); expect(await response.text()).not.toContain('private bridge error detail')
})

it.each(['disabled-tool', 'credential-rotation', 'revocation'])('checks %s again after shared connection recovery', async change => {
  let forwarded = 0, connected!: () => void, release!: () => void
  const connecting = new Promise<void>(resolve => { connected = resolve })
  const ready = new Promise<void>(resolve => { release = resolve })
  const upstream = await listen(createServer((_req, res) => { forwarded++; res.writeHead(200, { 'content-type': 'application/json' }).end('{"jsonrpc":"2.0","id":1,"result":{}}') }))
  let enabled = true
  let service = { name: 'p-shared', generation: 1, description: '', url: '', disabledTools: [] as string[], run: { location: 'shared' as const, command: 'fixture', args: [], env: [], prepareCommand: '' } }
  const handle = createMcpGateway({ wire: new McpHttpWire(), authorization: { authorize: () => 'alice' }, services: { effective: () => enabled ? [service] : [] }, transport: new NodePluginUpstreamTransport('idle'), connections: { track() {}, untrack() {} }, shared: { connect: async () => { connected(); await ready; return { name: 'p-shared', baseUrl: upstream, credential: '', headers: [] } } } })
  const origin = await listen(createServer((req, res) => { void handle(req, res) }))
  const response = fetch(origin + '/mcp/p-shared', { method: 'POST', headers: { authorization: 'Bearer member', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'write' } }) })
  await connecting
  if (change === 'disabled-tool') service = { ...service, disabledTools: ['write'] }
  if (change === 'credential-rotation') service = { ...service, generation: 2 }
  if (change === 'revocation') enabled = false
  release()
  const result = await response
  expect(await result.json()).toHaveProperty('error')
  expect(forwarded).toBe(0)
})

it('allows a silent shared response past the remote transport deadline without weakening remote timeouts', async () => {
  let sharedResponse: import('node:http').ServerResponse | undefined
  let remoteClosed!: () => void
  const closed = new Promise<void>(resolve => { remoteClosed = resolve })
  const upstream = await listen(createServer(async (request, response) => {
    for await (const chunk of request) { void chunk }
    response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders()
    if (request.url === '/shared') sharedResponse = response
    else response.once('close', remoteClosed)
  }))
  const services = [
    { name: 'p-shared', generation: 1, description: '', url: '', run: { location: 'shared' as const, command: 'fixture', args: [], env: [], prepareCommand: '' } },
    { name: 'p-remote', generation: 1, description: '', url: upstream + '/remote' },
  ]
  const handle = createMcpGateway({ wire: new McpHttpWire(), authorization: { authorize: () => 'alice' }, services: { effective: () => services },
    transport: new NodePluginUpstreamTransport('idle', 30), sharedTransport: new NodePluginUpstreamTransport('idle', 5000),
    connections: { track() {}, untrack() {} }, shared: { connect: async () => ({ name: 'p-shared', baseUrl: upstream + '/shared', credential: '', headers: [] }) } })
  const origin = await listen(createServer((request, response) => { void handle(request, response) }))
  const call = (name: string) => fetch(origin + '/mcp/' + name, { method: 'POST', headers: { authorization: 'Bearer member', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search' } }) }).then(response => response.text())
  const shared = call('p-shared'); void shared.catch(() => {})
  await expect.poll(() => Boolean(sharedResponse)).toBe(true)
  const remote = call('p-remote').catch(() => 'transport closed')
  await closed
  expect(await remote).toBe('transport closed')
  expect(sharedResponse!.destroyed).toBe(false)
  sharedResponse!.end('data: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"completed"}]}}\n\n')
  expect(await shared).toContain('completed')
})
