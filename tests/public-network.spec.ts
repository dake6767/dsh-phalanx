import { createServer as tcpServer } from 'node:net'
import { createServer as httpServer } from 'node:http'
import { expect, it } from 'vitest'
import { NodeNetworkTransport } from '../src/adapters/public-network.js'

it('removes the connection deadline after TCP connect and leaves connected transports without a platform idle deadline', async () => {
  const server = tcpServer(socket => { socket.on('data', data => socket.write(data)) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No TCP listener')
  const socket = await new NodeNetworkTransport().connect({ hostname: 'fixture.test', address: '127.0.0.1', port: address.port })
  try { expect(socket.timeout ?? 0).toBe(0) }
  finally { socket.destroy(); await new Promise<void>(resolve => { server.close(() => resolve()) }) }
})

it('keeps the HTTP response open without installing a socket idle deadline after headers', async () => {
  const server = httpServer((_request, response) => { response.writeHead(200); response.flushHeaders() })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address(); if (!address || typeof address === 'string') throw Error('No HTTP listener')
  const { request, response } = new NodeNetworkTransport().http({ hostname: 'fixture.test', address: '127.0.0.1', port: address.port }, { method: 'GET', path: '/', headers: {} })
  request.end()
  try { await response; expect(request.socket?.timeout ?? 0).toBe(0) }
  finally { request.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()) }) }
})
