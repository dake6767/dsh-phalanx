import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/** Hold the controlled response across the real RPC deadline without delaying browser traffic. */
export async function startNativeHistoryInventory() {
  let held = true
  const pending = new Map<ServerResponse, number>()
  const cancelled = new Map<number, number>()
  const complete = (response: ServerResponse) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ result: { ok: true, value: [] } }))
  }
  const server = createServer((request, response) => {
    request.resume()
    const port = Number(request.headers['x-test-inventory-port'])
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      response.writeHead(400).end()
      return
    }
    if (!held) {
      complete(response)
      return
    }
    pending.set(response, port)
    response.once('close', () => {
      pending.delete(response)
      if (!response.writableFinished) cancelled.set(port, (cancelled.get(port) ?? 0) + 1)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return {
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    cancelled: (port: number) => cancelled.get(port) ?? 0,
    pending: (port: number) => [...pending.values()].filter(value => value === port).length,
    hold: () => {
      held = true
    },
    release: () => {
      held = false
      for (const response of pending.keys()) complete(response)
    },
    close: async () => {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}
