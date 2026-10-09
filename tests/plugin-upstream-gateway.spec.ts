import { createServer, request as httpRequest, type Server } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import { createPluginUpstreamGateway } from '../src/inbound/plugin-upstream-gateway.js'
import { NodePluginUpstreamTransport } from '../src/adapters/plugin-upstream-transport.js'
import { PluginUpstreamAccessError } from '../src/domain/plugin-upstream.js'
const servers: Server[] = []
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } })
async function listen(server: Server) { servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); const a = server.address(); if (!a || typeof a === 'string') throw Error('missing address'); return `http://127.0.0.1:${a.port}` }
it('preserves encoded paths and cancellation through the HTTP entry and recognizes duplicate raw authorization', async () => {
  let upstreamClosed!: () => void
  const closed = new Promise<void>(resolve => { upstreamClosed = resolve })
  const received: string[] = []
  const upstream = await listen(createServer((req, res) => { received.push(req.url!); res.setHeader('content-type', 'text/event-stream'); res.write('data: first\n\n'); res.once('close', upstreamClosed) }))
  const handle = createPluginUpstreamGateway({ connections: { track: () => {}, untrack: () => {} }, transport: new NodePluginUpstreamTransport(), access: { authorize: (pkg, name, headers) => {
    expect(pkg).toBe('@sample/plugin'); expect(name).toBe('search')
    if (Array.isArray(headers.authorization) && headers.authorization.length > 1) throw new PluginUpstreamAccessError(401, 'Conflicting tokens')
    return { username: 'member', upstream: { name, baseUrl: upstream + '/base', credential: 'key', headers: [] } }
  } } })
  const origin = await listen(createServer((req, res) => { void handle(req, res) }))
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(origin + '/plugins/%40sample%2Fplugin/search/a%2Fb?q=a%20b', { headers: { authorization: 'Bearer member' } }, response => {
      response.once('data', () => { request.destroy(); resolve() })
    }); request.once('error', reject); request.end()
  })
  await closed; expect(received).toEqual(['/base/a%2Fb?q=a%20b'])
  const result = await new Promise<number>(resolve => {
    const request = httpRequest(origin + '/plugins/%40sample%2Fplugin/search/', { headers: ['Host', new URL(origin).host, 'Authorization', 'Bearer one', 'Authorization', 'Bearer two'] }, response => { response.resume(); resolve(response.statusCode!) }); request.end()
  })
  expect(result).toBe(401); expect(received).toHaveLength(1)
})
