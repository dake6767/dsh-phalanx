import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createMcpGateway } from '../src/inbound/mcp-gateway.js'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
import { NodePluginUpstreamTransport } from '../src/adapters/plugin-upstream-transport.js'
import { McpHttpWire } from '../src/adapters/mcp-wire.js'
import { UsagePolicy } from '../src/use-cases/usage-policy.js'
import { SqliteUsageRecords } from '../src/adapters/usage-records.js'

it('records only MCP tool calls with their initial group and protocol outcome, without payloads', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mcp-usage-')), store = new SqliteUsageRecords(join(root, 'usage.db'))
  const servers: Server[] = []
  const listen = async (server: Server) => { servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return `http://127.0.0.1:${(server.address() as { port: number }).port}` }
  let groupId = 'before', now = 1000, enabled = true, disabled = false, allowed = true, received = 0, breakTransport = false, hold = false
  let entered!: () => void
  const arrived = new Promise<void>(resolve => { entered = resolve })
  const account = () => ({ username: 'member', spaceId: 'space', groupId, admin: true, disabled, sessionEpoch: 0, email: '', createdAt: 0, updatedAt: 0 })
  const usage = new UsagePolicy(store, { now: () => now }, { get: account }, { allow: () => allowed })
  try {
    const upstream = await listen(createServer(async (request, response) => {
      received++
      if (breakTransport) { request.socket.destroy(); return }
      let text = ''; for await (const chunk of request) text += chunk
      const body = JSON.parse(text) as { id: number, method: string }
      if (hold) { entered(); await new Promise<void>(resolve => request.socket.once('close', () => resolve())); return }
      groupId = 'after'; now += 25
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: body.method === 'tools/list' ? { tools: [] } : { isError: true, content: [{ type: 'text', text: 'PRIVATE_OUTPUT' }] } }))
    }))
    const authorization = new CommunityModelAuthorization({ getState: account, get: account }, { resolve: token => token === 'member' || token === 'retired' ? { username: 'member', spaceId: token === 'retired' ? 'retired' : 'space' } : undefined })
    const handler = createMcpGateway({ authorization, usage, wire: new McpHttpWire(), services: { effective: () => enabled ? [{ name: 'p-docs', generation: 1, description: '', url: upstream }] : [] }, transport: new NodePluginUpstreamTransport('idle'), connections: { track() {}, untrack() {} } })
    const origin = await listen(createServer((request, response) => { void handler(request, response) }))
    const send = (method: string) => fetch(origin + '/mcp/p-docs', { method: 'POST', headers: { authorization: 'Bearer member', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { name: 'lookup', arguments: { query: 'PRIVATE_QUERY' } } }) })
    expect(await (await send('tools/call')).json()).toMatchObject({ result: { isError: true } })
    expect((await send('tools/list')).status).toBe(200)
    const records = usage.view({ username: 'member', spaceId: 'space', sessionEpoch: 0 }, {})
    expect(records.total).toBe(1)
    expect(records.items).toMatchObject([{ username: 'member', groupId: 'before', capability: { kind: 'mcp', id: 'p-docs', operation: 'lookup' }, outcome: 'failed', isError: true, httpStatus: 200, startedAt: 1000, durationMs: 25 }])
    expect(JSON.stringify(records)).not.toContain('PRIVATE_')
    enabled = false
    expect((await send('tools/call')).status).toBe(403)
    enabled = true; disabled = true
    expect((await send('tools/call')).status).toBe(403)
    disabled = false; allowed = false
    const batch = await fetch(origin + '/mcp/p-docs', { method: 'POST', headers: { authorization: 'Bearer member', 'content-type': 'application/json' }, body: JSON.stringify([
      { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'one', arguments: { secret: 'PRIVATE_QUERY' } } },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'two' } },
    ]) })
    expect(batch.status).toBe(200)
    expect(await batch.json()).toMatchObject([{ id: 'a', result: { isError: true } }, { id: 2, result: { isError: true } }])
    // Protocol discovery still works under a tool admission refusal.
    expect((await send('tools/list')).status).toBe(200)
    expect(received).toBe(3)
    const denied = usage.view({ username: 'member', spaceId: 'space', sessionEpoch: 0 }, { outcome: 'denied' })
    expect(denied.total).toBe(4)
    expect(denied.items.filter(row => row.reason === 'policy')).toHaveLength(2)
    expect(denied.items.filter(row => row.reason === 'access')).toHaveLength(2)
    const beforeInvalid = usage.view({ username: 'member', spaceId: 'space', sessionEpoch: 0 }, {}).total
    expect((await fetch(origin + '/mcp/p-docs', { method: 'POST', headers: { authorization: 'Bearer invalid', 'content-type': 'application/json' }, body: '{}' })).status).toBe(401)
    expect((await fetch(origin + '/mcp/p-docs', { method: 'POST', headers: { authorization: 'Bearer retired', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403)
    expect(usage.view({ username: 'member', spaceId: 'space', sessionEpoch: 0 }, {}).total).toBe(beforeInvalid)
    allowed = true; breakTransport = true
    expect((await send('tools/call')).status).toBe(502)
    expect(usage.view({ username: 'member', spaceId: 'space', sessionEpoch: 0 }, {}).items[0]).toMatchObject({ outcome: 'failed', reason: 'transport', httpStatus: 502 })
    breakTransport = false; hold = true
    const beforeCancel = usage.view({ username: 'member', spaceId: 'space', sessionEpoch: 0 }, {}).total
    const controller = new AbortController()
    const interrupted = fetch(origin + '/mcp/p-docs', { method: 'POST', signal: controller.signal, headers: { authorization: 'Bearer member', 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"lookup"}}' }).catch(() => undefined)
    await arrived; controller.abort(); await interrupted
    await expect.poll(() => usage.view({ username: 'member', spaceId: 'space', sessionEpoch: 0 }, {}).total).toBe(beforeCancel + 1)
    const cancelled = usage.view({ username: 'member', spaceId: 'space', sessionEpoch: 0 }, {}).items[0]
    expect(cancelled).toMatchObject({ outcome: 'failed', reason: 'cancelled' })
    expect(cancelled).not.toHaveProperty('httpStatus')
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})
