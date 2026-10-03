import { createServer, request, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Duplex } from 'node:stream'
import { expect, it } from 'vitest'
import { createCommunityNetworkProxy } from '../src/inbound/community-network-proxy.js'
import { CommunityNetworkAccess } from '../src/use-cases/community-network-access.js'
import { CommunityModelAuthorization } from '../src/use-cases/community-model-authorization.js'
import { NodeNetworkResolver } from '../src/adapters/public-network.js'
import { MemorySessionRegistry } from '../src/adapters/memory-session-registry.js'

it('accepts standard CONNECT authentication and fails closed without a deployment host inventory', async () => {
  const connections = new MemorySessionRegistry()
  const authorization = new CommunityModelAuthorization({ getState: () => ({ username: 'alice', disabled: false, admin: false, sessionEpoch: 0 }) },
    { resolve: token => token === 'alice-token' ? 'alice' : undefined })
  const access = new CommunityNetworkAccess(authorization, { resolve: async () => ['1.1.1.1'], hostAddresses: () => [] })
  const transport = {
    async connect() { return new Duplex({ read() {}, write(_chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) { callback() } }) },
    http() { throw new Error('CONNECT must use the tunnel transport') },
  }
  let proxy = createCommunityNetworkProxy({ access, connections, transport })
  const server = createServer()
  server.on('connection', socket => connections.registerConnection(socket, false))
  server.on('connect', (req, socket, head) => { void proxy.connect(req, socket, head) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const tunnel = (identity: string, target = 'example.test:80') => new Promise<{ status: number, headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: (server.address() as AddressInfo).port, method: 'CONNECT', path: target,
      headers: { 'proxy-authorization': `Basic ${Buffer.from(identity).toString('base64')}` } })
    req.on('connect', (res, socket) => { resolve({ status: res.statusCode!, headers: res.headers }); socket.destroy() })
    req.on('response', res => { res.resume(); resolve({ status: res.statusCode!, headers: res.headers }) })
    req.on('error', reject); req.end()
  })
  try {
    expect((await tunnel('dsh:alice-token')).status).toBe(200)
    const malformed = await tunnel('alice-token')
    expect(malformed.status).toBe(407)
    expect(malformed.headers['proxy-authenticate']).toBe('Basic realm="Community public network"')
    proxy = createCommunityNetworkProxy({ access: new CommunityNetworkAccess(authorization, new NodeNetworkResolver()), connections, transport })
    expect((await tunnel('dsh:alice-token', '1.1.1.1:443')).status).toBe(502)
    proxy = createCommunityNetworkProxy({ access: new CommunityNetworkAccess(authorization, new NodeNetworkResolver(undefined, ['8.8.8.8'])), connections, transport })
    expect((await tunnel('dsh:alice-token', '8.8.8.8:22')).status).toBe(403)
  } finally { connections.closeAll(); await new Promise<void>(resolve => server.close(() => resolve())) }
})
