import { once } from 'node:events'
import { createServer as createHttpServer, get, type IncomingMessage, type ServerResponse } from 'node:http'
import { createConnection, createServer as createTcpServer, type Server, type Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { createRuntimeProxy } from '../src/inbound/runtime-proxy.js'

async function listen(server: Server): Promise<number> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
  return address.port
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()))
  })
}

it('uses the upstream keep-alive hint and safety buffer for pooled sockets', async () => {
  const upstream = createHttpServer((_request, response) => {
    response.setHeader('Keep-Alive', 'timeout=3')
    response.end('ready')
  })
  const port = await listen(upstream)
  const { agent } = createRuntimeProxy()
  try {
    const pooled = once(agent, 'free')
    const received = new Promise<void>((resolve, reject) => {
      const request = get({ hostname: '127.0.0.1', port, agent }, response => {
        response.resume()
        response.once('end', resolve)
        response.once('error', reject)
      })
      request.once('error', reject)
    })
    const [[socket]] = await Promise.all([pooled, received])
    expect(socket.timeout).toBeGreaterThan(0)
    expect(socket.timeout).toBeLessThanOrEqual(2_000)
  } finally {
    agent.destroy()
    await close(upstream)
  }
})

it('retires the idle socket before the upstream closes and delivers the first prompt once when the FIN is delayed', async () => {
  let prompts = 0
  const upstream = createHttpServer({ keepAliveTimeout: 2_000 }, (request, response) => {
    if (request.method === 'POST') {
      prompts++
      request.resume()
      request.once('end', () => response.end('prompt accepted'))
      return
    }
    response.end('ready')
  })
  const upstreamPort = await listen(upstream)
  const connections = new Set<Socket>()
  let resolveUpstreamClosed!: () => void
  const upstreamClosed = new Promise<void>(resolve => {
    resolveUpstreamClosed = resolve
  })
  let forwardedConnections = 0
  const forwarder = createTcpServer({ allowHalfOpen: true }, downstream => {
    const first = ++forwardedConnections === 1
    let awaitingFinDelivery = false
    const remote = createConnection({ host: '127.0.0.1', port: upstreamPort, allowHalfOpen: true })
    connections.add(downstream)
    connections.add(remote)
    remote.pipe(downstream, { end: false })
    remote.on('end', () => {
      if (first) {
        awaitingFinDelivery = true
        resolveUpstreamClosed()
      } else {
        downstream.end()
      }
    })
    downstream.on('data', chunk => {
      if (awaitingFinDelivery) downstream.resetAndDestroy()
      else remote.write(chunk)
    })
    // Keep the first upstream leg open until its server closes it, even when
    // the proxy has already retired its own leg.
    downstream.on('end', () => {
      downstream.end()
      if (!first) remote.end()
    })
    for (const socket of [remote, downstream]) {
      socket.on('error', () => socket.destroy())
      socket.on('close', () => connections.delete(socket))
    }
  })
  const target = `http://127.0.0.1:${await listen(forwarder)}`
  const { agent, proxy } = createRuntimeProxy()
  const entry = createHttpServer((request, response) => proxy.web(request, response, { target }))
  const origin = `http://127.0.0.1:${await listen(entry)}`
  let upstreamResponse: IncomingMessage | undefined
  let pooledTimeout: number | undefined
  proxy.on('proxyRes', response => {
    upstreamResponse = response
  })
  agent.on('free', (socket: Socket) => {
    pooledTimeout ??= socket.timeout
  })

  try {
    expect(await (await fetch(origin + '/ready')).text()).toBe('ready')
    expect(upstreamResponse?.headers['keep-alive']).toMatch(/^timeout=2(?:,|$)/u)
    await upstreamClosed
    const response = await fetch(origin + '/session/prompt', { method: 'POST', body: 'hello' })
    expect({ status: response.status, body: await response.text(), prompts }).toEqual({
      status: 200,
      body: 'prompt accepted',
      prompts: 1,
    })
    expect(pooledTimeout).toBeGreaterThan(0)
    expect(pooledTimeout).toBeLessThanOrEqual(1_000)
    expect(forwardedConnections).toBe(2)
  } finally {
    agent.destroy()
    entry.closeAllConnections()
    upstream.closeAllConnections()
    for (const socket of connections) socket.destroy()
    await Promise.all([close(entry), close(forwarder), close(upstream)])
  }
})

it('returns a gateway error without replaying a prompt already received by the upstream', async () => {
  const prompts: string[] = []
  const upstream = createHttpServer(async (request, response) => {
    request.setEncoding('utf8')
    let body = ''
    for await (const chunk of request) body += chunk
    prompts.push(body)
    if (prompts.length === 1) request.socket.resetAndDestroy()
    else response.end('unexpected replay')
  })
  const target = `http://127.0.0.1:${await listen(upstream)}`
  const { agent, proxy } = createRuntimeProxy()
  const entry = createHttpServer((request, response) => proxy.web(request, response, { target }))
  const origin = `http://127.0.0.1:${await listen(entry)}`
  try {
    const response = await fetch(origin + '/session/prompt', { method: 'POST', body: 'one prompt' })
    expect(response.status).toBe(502)
    expect(await response.text()).toBe('Bad Gateway')
    expect(prompts).toEqual(['one prompt'])
  } finally {
    agent.destroy()
    entry.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([close(entry), close(upstream)])
  }
})

it('keeps a streaming response and a WebSocket open through seven seconds of silence', async () => {
  let resolveStream!: (response: ServerResponse) => void
  const stream = new Promise<ServerResponse>(resolve => {
    resolveStream = resolve
  })
  const upstream = createHttpServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: ready\n\n')
    resolveStream(response)
  })
  const upgrades = new WebSocketServer({ noServer: true })
  upstream.on('upgrade', (request, socket, head) => {
    upgrades.handleUpgrade(request, socket, head, ws => ws.on('message', data => ws.send(data.toString())))
  })
  const target = `http://127.0.0.1:${await listen(upstream)}`
  const { agent, proxy } = createRuntimeProxy()
  const entry = createHttpServer((request, response) => proxy.web(request, response, { target }))
  entry.on('upgrade', (request, socket, head) => proxy.ws(request, socket, head, { target }))
  const port = await listen(entry)
  const ws = new WebSocket(`ws://127.0.0.1:${port}/session/events`)
  try {
    const [response] = await Promise.all([fetch(`http://127.0.0.1:${port}/stream`), once(ws, 'open')])
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    const decode = new TextDecoder()
    expect(decode.decode((await reader.read()).value)).toBe('data: ready\n\n')

    await delay(7_000)

    const message = once(ws, 'message')
    ws.send('still connected')
    expect((await message)[0].toString()).toBe('still connected')
    const upstreamStream = await stream
    upstreamStream.end('data: finished\n\n')
    expect(decode.decode((await reader.read()).value)).toBe('data: finished\n\n')
    expect((await reader.read()).done).toBe(true)
  } finally {
    for (const peer of upgrades.clients) peer.terminate()
    ws.terminate()
    upgrades.close()
    agent.destroy()
    entry.closeAllConnections()
    upstream.closeAllConnections()
    await Promise.all([close(entry), close(upstream)])
  }
})
