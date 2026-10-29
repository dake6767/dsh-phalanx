import { createServer as httpServer, type RequestListener } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { readFile } from 'node:fs/promises'
import type { Socket } from 'node:net'
import { createProxyServer } from 'http-proxy-3'

/** Real TLS terminators only: all routing, authorization and isolation remain in the product. */
export async function previewListeners(tls: boolean, backendPort: number, previewPort: number) {
  const cert = tls ? await readFile(process.env.DSH_PHALANX_PREVIEW_TEST_CERT!) : undefined
  const key = tls ? await readFile(process.env.DSH_PHALANX_PREVIEW_TEST_KEY!) : undefined
  const sockets = new Set<Socket>()
  const proxies = [backendPort, previewPort].map(port => {
    const proxy = createProxyServer({ ws: true })
    proxy.on('error', (_error, _request, response) => response.destroy())
    const target = `http://127.0.0.1:${port}`
    const handler: RequestListener = (request, response) => proxy.web(request, response, { target })
    const server = tls ? httpsServer({ cert, key }, handler) : httpServer(handler)
    server.on('upgrade', (request, socket, head) => proxy.ws(request, socket, head, { target }))
    server.on('connection', socket => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    return { proxy, server }
  })
  const origins: string[] = []
  for (const { server } of proxies) {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw Error('Missing test listener')
    origins.push(`http${tls ? 's' : ''}://127.0.0.1:${address.port}`)
  }
  return {
    origin: origins[0]!,
    previewOrigin: origins[1]!,
    cert,
    async close() {
      for (const socket of sockets) socket.destroy()
      for (const { server, proxy } of proxies) {
        proxy.close()
        await new Promise<void>(resolve => server.close(() => resolve()))
      }
    },
  }
}
