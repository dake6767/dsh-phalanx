import { UsagePolicy } from '../src/use-cases/usage-policy.js'
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
  const rows: import('../src/domain/usage-record.js').UsageEntry[] = []
  let recordFinished!: () => void
  const recorded = new Promise<void>(resolve => { recordFinished = resolve })
  const usage = new UsagePolicy({ appendModel() { throw Error('unused') }, models() { throw Error('unused') }, append: row => { rows.push(row); recordFinished() }, prune() {}, retentionDays: () => 180, saveRetention() {}, view: () => { throw Error('unused') } }, { now: () => 1000 }, { get: () => undefined })
  let upstreamClosed!: () => void
  const closed = new Promise<void>(resolve => { upstreamClosed = resolve })
  const received: string[] = []
  const upstream = await listen(createServer((req, res) => { received.push(req.url!); res.setHeader('content-type', 'text/event-stream'); res.write('data: first\n\n'); res.once('close', upstreamClosed) }))
  const handle = createPluginUpstreamGateway({ usage, connections: { track: () => {}, untrack: () => {} }, transport: new NodePluginUpstreamTransport(), access: { authorize: (pkg, name, headers, identified) => {
    expect(pkg).toBe('@sample/plugin'); expect(name).toBe('search')
    if (Array.isArray(headers.authorization) && headers.authorization.length > 1) throw new PluginUpstreamAccessError(401, 'Conflicting tokens')
    identified?.({ username: 'member', groupId: 'g' })
    return { username: 'member', upstream: { name, baseUrl: upstream + '/base', credential: 'key', headers: [] } }
  } } })
  const origin = await listen(createServer((req, res) => { void handle(req, res) }))
  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(origin + '/plugins/%40sample%2Fplugin/search/a%2Fb?q=a%20b', { headers: { authorization: 'Bearer member' } }, response => {
      response.once('data', () => { request.destroy(); resolve() })
    }); request.once('error', reject); request.end()
  })
  await closed; await recorded; expect(rows).toMatchObject([{ outcome: 'failed', reason: 'cancelled', httpStatus: 200 }]); expect(received).toEqual(['/base/a%2Fb?q=a%20b'])
  const result = await new Promise<number>(resolve => {
    const request = httpRequest(origin + '/plugins/%40sample%2Fplugin/search/', { headers: ['Host', new URL(origin).host, 'Authorization', 'Bearer one', 'Authorization', 'Bearer two'] }, response => { response.resume(); resolve(response.statusCode!) }); request.end()
  })
  expect(result).toBe(401); expect(received).toHaveLength(1)
})

it('records attributable access failures and completed HTTP results, and returns the platform policy denial', async () => {
  const rows: import('../src/domain/usage-record.js').UsageEntry[] = []
  let allow = true, access = true
  const usage = new UsagePolicy({ appendModel() { throw Error('unused') }, models() { throw Error('unused') }, append: row => { rows.push(row) }, prune() {}, retentionDays: () => 180, saveRetention() {}, view: () => { throw Error('unused') } }, { now: () => 1000 }, { get: () => undefined }, { allow: () => allow })
  const upstream = await listen(createServer((_req, res) => { res.writeHead(201); res.end('PRIVATE_RESPONSE') }))
  const handle = createPluginUpstreamGateway({ usage, connections: { track() {}, untrack() {} }, transport: new NodePluginUpstreamTransport(), access: { authorize: (_pkg, name, headers, identified) => {
    if (headers.authorization?.[0] !== 'Bearer member') throw new PluginUpstreamAccessError(401, 'Invalid member token')
    identified?.({ username: 'member', groupId: 'original' })
    if (!access) throw new PluginUpstreamAccessError(403, 'Member is not authorized')
    return { username: 'member', upstream: { name, baseUrl: upstream, credential: 'key', headers: [] } }
  } } })
  const origin = await listen(createServer((req, res) => { void handle(req, res) }))
  const call = (token = 'member') => fetch(origin + '/plugins/fixture/search/private-query?private=value', { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: 'PRIVATE_BODY' })
  expect(await (await call()).text()).toBe('PRIVATE_RESPONSE')
  expect(rows).toMatchObject([{ username: 'member', groupId: 'original', capability: { kind: 'plugin-upstream', id: 'fixture', operation: 'search' }, outcome: 'succeeded', httpStatus: 201 }])
  access = false; expect((await call()).status).toBe(403)
  expect(rows.at(-1)).toMatchObject({ outcome: 'denied', reason: 'access' })
  expect((await call('invalid')).status).toBe(401); expect(rows).toHaveLength(2)
  access = true; allow = false
  const denied = await call(); expect(denied.status).toBe(403); expect(await denied.json()).toEqual({ code: 'usage-not-allowed', error: 'This use is not allowed.' })
  expect(rows.at(-1)).toMatchObject({ outcome: 'denied', reason: 'policy' })
  expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|private-query|private=value|Bearer|key/)
})
