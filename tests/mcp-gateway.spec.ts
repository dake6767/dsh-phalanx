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
it('forwards the exact MCP endpoint without credentials, rejects revoked grants and duplicate tokens, and preserves streaming', async () => {
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
  const handle = createMcpGateway({ wire: new McpHttpWire(), authorization, services: { effective: () => enabled ? [{ name: 'p-docs', generation: 1, description: '', url: upstream + '/mcp/?scope=read' }] : [] }, transport: new NodePluginUpstreamTransport('idle'), connections: { track: () => {}, untrack: () => {} } })
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
  const handle = createMcpGateway({ wire: new McpHttpWire(), authorization: { authorize: () => 'alice' }, services: { effective: () => [service] }, transport: new NodePluginUpstreamTransport('idle'), connections: { track() {}, untrack() {} }, shared: { connect: async () => ({ name: 'p-shared', baseUrl: upstream, credential: '', headers: [] }) } })
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
