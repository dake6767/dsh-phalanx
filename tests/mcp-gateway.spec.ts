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
    if (req.method === 'GET') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: first\n\n'); finish = () => res.end('data: last\n\n'); return }
    let data = ''; for await (const chunk of req) data += chunk
    res.writeHead(200, { 'set-cookie': 'private=true', 'content-type': 'application/json' }); res.end(data)
  }))
  const authorization = new CommunityModelAuthorization({ getState: () => ({ username: 'member', spaceId: 'space', disabled, sessionEpoch: 0, admin: false, groupId: 'group' }) }, { resolve: token => token === 'member' ? { username: 'member', spaceId: 'space' } : undefined })
  const handle = createMcpGateway({ authorization, services: { effective: () => enabled ? [{ name: 'p-docs', generation: 1, description: '', url: upstream + '/mcp/?scope=read' }] : [] }, transport: new NodePluginUpstreamTransport('idle'), connections: { track: () => {}, untrack: () => {} } })
  const origin = await listen(createServer((req, res) => { void handle(req, res) }))
  const send = () => new Promise<Response>((resolve, reject) => {
    const req = httpRequest(origin + '/mcp/p-docs', { method: 'POST', headers: { authorization: 'Bearer member', cookie: 'private', 'x-api-key': 'private', connection: 'x-forged', 'x-forged': 'private' } }, res => {
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
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: first\n\n'); finish!()
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: last\n\n'); expect((await reader.read()).done).toBe(true)
})
