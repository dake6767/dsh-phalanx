import { mcpPolicy } from './support/account-state.js'
import { modelAuthority } from './support/account-state.js'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { expect, it } from 'vitest'
import { GatewayMcpProbe } from '../src/adapters/mcp-probe.js'
import { McpHttpWire } from '../src/adapters/mcp-wire.js'
import { NodePluginUpstreamTransport } from '../src/adapters/plugin-upstream-transport.js'
import { createMcpGateway } from '../src/inbound/mcp-gateway.js'
import type { McpService } from '../src/domain/mcp-service.js'
import type { UsageEntry } from '../src/domain/usage-record.js'
import { UsagePolicy } from '../src/use-cases/usage-policy.js'
async function listen(server: Server) {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw Error('address')
  return new URL(`http://127.0.0.1:${address.port}`)
}
async function close(server: Server) {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
}
it('discovers paged JSON/SSE tools through the real gateway while locking credentials and blocking disabled batch calls', async () => {
  const observed: {
      method: string
      auth: string | undefined
      key: string | null
      session: string | string[] | undefined
    }[] = [],
    audit: UsageEntry[] = []
  let calls = 0,
    deleted = false,
    malformed = false
  const upstream = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    if (req.method === 'DELETE') {
      deleted = true
      res.writeHead(204)
      res.end()
      return
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const input = JSON.parse(raw)
    if (malformed) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{bad')
      return
    }
    if (Array.isArray(input)) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify(
          input.map(row => ({ jsonrpc: '2.0', id: row.id, ...(row.params.name === 'read' ? { result: {} } : { error: { code: -1, message: 'failed' } }) })),
        ),
      )
      return
    }
    observed.push({ method: input.method, auth: req.headers.authorization, key: url.searchParams.get('key'), session: req.headers['mcp-session-id'] })
    expect(req.headers.cookie).toBeUndefined()
    expect(req.headers['proxy-authorization']).toBeUndefined()
    expect(req.headers['x-api-key']).toBeUndefined()
    if (input.method === 'notifications/initialized') {
      res.writeHead(202)
      res.end()
      return
    }
    let result: unknown
    if (input.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
    else if (input.method === 'tools/list')
      result = input.params?.cursor
        ? { tools: [{ name: 'new', inputSchema: { type: 'object' } }] }
        : {
            tools: [
              { name: 'read', description: 'fictional-platform-secret', inputSchema: { type: 'object' } },
              { name: 'write', inputSchema: { type: 'object' } },
            ],
            nextCursor: 'page-2',
          }
    else {
      calls++
      result = { content: [{ type: 'text', text: 'fictional-platform-secret' }] }
    }
    const body = JSON.stringify({ jsonrpc: '2.0', id: input.id, result })
    const sse = input.params?.cursor
    res.writeHead(200, { 'content-type': sse ? 'text/event-stream' : 'application/json', 'mcp-session-id': 'session', 'x-leak': 'fictional-platform-secret' })
    res.end(sse ? ': fictional-platform-secret\n\ndata: ' + body + '\n\n' : body)
  })
  const upstreamOrigin = await listen(upstream)
  let service: McpService = {
    name: 'p-tools',
    generation: 1,
    description: '',
    url: new URL('/mcp?key=old', upstreamOrigin).href,
    credential: 'fictional-platform-secret',
    headers: [{ name: 'Authorization', value: 'Bearer {credential}' }],
    query: [{ name: 'key', value: '{credential}' }],
    disabledTools: ['write'],
  }
  const wire = new McpHttpWire()
  const usage = new UsagePolicy(
    {
      async appendReported() {
        throw Error('unused')
      },
      async reported() {
        throw Error('unused')
      },
      async appendModel() {
        throw Error('unused')
      },
      async models() {
        throw Error('unused')
      },
      append: async row => {
        audit.push(row)
      },
      async prune() {},
      retentionDays: async () => 180,
      async saveRetention() {},
      view: async () => {
        throw Error('unused')
      },
    },
    { now: () => 100 },
    { get: async () => undefined },
  )
  const handler = createMcpGateway({
    wire,
    authorization: modelAuthority(async (token, identified) => {
      if (token !== 'admin' && token !== 'member') throw Error('unauthorized')
      identified?.({ username: token, groupId: 'group' })
      return token
    }),
    services: mcpPolicy({
      effective: async user => (user === 'member' ? [service] : []),
      diagnostic: async user => {
        if (user !== 'admin') throw Error('unauthorized')
        return service
      },
    }),
    transport: new NodePluginUpstreamTransport('idle'),
    usage,
    connections: { track: () => {}, untrack: () => {} },
  })
  const gateway = createServer((req, res) => {
      void handler(req, res)
    }),
    origin = await listen(gateway)
  const probe = new GatewayMcpProbe(() => origin, { forUser: async () => 'admin' }, wire)
  const exchange = async (body: unknown) => {
    const response = await fetch(new URL('/mcp/p-tools', origin), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer member',
        cookie: 'private',
        'proxy-authorization': 'private',
        'x-api-key': 'private',
      },
      body: JSON.stringify(body),
    })
    return response
  }
  try {
    expect((await probe.probe('admin', 'space', 'p-tools')).map(row => row.name)).toEqual(['read', 'write', 'new'])
    expect(deleted).toBe(true)
    expect(observed).toHaveLength(4)
    expect(observed.every(row => row.auth === 'Bearer fictional-platform-secret' && row.key === 'fictional-platform-secret')).toBe(true)
    expect(observed.slice(1).every(row => row.session === 'session')).toBe(true)
    const list = await exchange({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(list.headers.has('x-leak')).toBe(false)
    expect((await list.json()).result.tools).toEqual([{ name: 'read', description: '[redacted]', inputSchema: { type: 'object' } }])
    const response = await exchange([
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read', arguments: { sensitive: 'not audited' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'write' } },
    ])
    expect(
      (await response.json()).map(
        (row: {
          error: {
            code: number
          }
        }) => row.error.code,
      ),
    ).toEqual([-32602, -32602])
    expect(calls).toBe(0)
    service = { ...service, credential: 'rotated-fictional-secret', disabledTools: [] }
    await (await exchange({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'new' } })).text()
    expect(observed.at(-1)?.auth).toBe('Bearer rotated-fictional-secret')
    expect(observed.at(-1)?.key).toBe('rotated-fictional-secret')
    expect(calls).toBe(1)
    expect(audit.filter(row => row.outcome === 'denied').map(row => row.capability.operation)).toEqual(['read', 'write'])
    await (
      await exchange([
        { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'read' } },
        { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'new' } },
      ])
    ).json()
    expect(audit.slice(-2).map(row => [row.capability.operation, row.outcome])).toEqual([
      ['read', 'succeeded'],
      ['new', 'failed'],
    ])
    const beforeMalformed = audit.length
    malformed = true
    await expect(exchange({ jsonrpc: '2.0', id: 7, method: 'tools/list' }).then(response => response.text())).rejects.toThrow()
    expect(audit).toHaveLength(beforeMalformed)
    expect(JSON.stringify(audit)).not.toContain('secret')
    expect(JSON.stringify(audit)).not.toContain('sensitive')
    expect(audit.every(row => row.durationMs === 0)).toBe(true)
    await probe.stop()
    await expect(probe.probe('admin', 'space', 'p-tools')).rejects.toThrow('stopped')
  } finally {
    await probe.stop()
    await close(gateway)
    await close(upstream)
  }
})
it('does not retain a pending diagnostic when obtaining its origin or access token fails', async () => {
  for (const fail of ['origin', 'token']) {
    const probe = new GatewayMcpProbe(
      () => {
        if (fail === 'origin') throw Error('not ready')
        return new URL('http://localhost')
      },
      {
        forUser: async () => {
          throw Error('store unavailable')
        },
      },
      new McpHttpWire(),
    )
    await expect(probe.probe('admin', 'space', 'p-tools')).rejects.toThrow()
    await probe.stop()
  }
})
