import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createProxyServer } from 'http-proxy-3'
import type { Socket } from 'node:net'

/** Hold one real download after its first bytes while normal native traffic keeps flowing. */
export async function downloadProxy(backend: string) {
  const proxy = createProxyServer({ target: backend, ws: true })
  proxy.on('error', (_error, _request, response) => response.destroy())
  let gate: { reached: () => void; release: Promise<void> } | undefined
  let resume: (() => void) | undefined
  const sockets = new Set<Socket>()
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || !request.url?.includes('/api/phalanx.download?') || !gate) {
      proxy.web(request, response)
      return
    }
    const current = gate
    gate = undefined
    const upstream = httpRequest(new URL(request.url, backend), { headers: request.headers }, incoming => {
      response.writeHead(incoming.statusCode!, incoming.headers)
      incoming.once('data', (chunk: Buffer) => {
        incoming.pause()
        response.write(chunk)
        current.reached()
        void current.release.then(() => {
          incoming.pipe(response)
        })
      })
      incoming.on('aborted', () => response.destroy())
      incoming.on('error', () => response.destroy())
    })
    upstream.on('error', () => response.destroy())
    request.pipe(upstream)
    response.on('close', () => upstream.destroy())
  })
  server.on('upgrade', (request, socket, head) => proxy.ws(request, socket, head))
  server.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hold() {
      let reached!: () => void
      const ready = new Promise<void>(resolve => {
        reached = resolve
      })
      const release = new Promise<void>(resolve => {
        resume = resolve
      })
      gate = { reached, release }
      return { ready, release: () => resume?.() }
    },
    async close() {
      resume?.()
      proxy.close()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
