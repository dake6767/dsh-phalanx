import { McpHttpWire } from '../src/adapters/mcp-wire.js'
/** Separate real-time validation: shortened idle windows exercise the product MCP transport and gateway. */
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { performance } from 'node:perf_hooks'
import { createMcpGateway } from '../src/inbound/mcp-gateway.js'
import { NodePluginUpstreamTransport } from '../src/adapters/plugin-upstream-transport.js'
const servers: Server[] = []
const idleMs = 400
async function listen(server: Server) {
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}
let mode = 'active'
const upstream = await listen(
  createServer((request, response) => {
    request.resume()
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"jsonrpc":"2.0","method":"start"}\n\n')
    if (mode === 'idle') return
    let frames = 0
    const timer = setInterval(() => {
      response.write(`data: {"jsonrpc":"2.0","method":"frame-${++frames}"}\n\n`)
      if (frames === 20) {
        clearInterval(timer)
        response.end()
      }
    }, 70)
    response.once('close', () => clearInterval(timer))
  }),
)
const gateway = createMcpGateway({
  wire: new McpHttpWire(),
  authorization: { authorize: () => 'member' },
  services: { effective: () => [{ name: 'p-stream', generation: 1, description: '', url: upstream }] },
  transport: new NodePluginUpstreamTransport('idle', idleMs),
  connections: { track: () => {}, untrack: () => {} },
})
const origin = await listen(
  createServer((request, response) => {
    void gateway(request, response)
  }),
)
try {
  const start = performance.now()
  const active = await fetch(origin + '/mcp/p-stream', { headers: { authorization: 'Bearer fixture' } })
  const content = await active.text(),
    activeMs = performance.now() - start
  assert(content.includes('frame-20'))
  assert(activeMs > idleMs * 3)
  mode = 'idle'
  const stalled = await fetch(origin + '/mcp/p-stream', { headers: { authorization: 'Bearer fixture' } })
  const reader = stalled.body!.getReader()
  await reader.read()
  const stalledStart = performance.now()
  await assert.rejects(reader.read())
  const stalledMs = performance.now() - stalledStart
  assert(stalledMs < idleMs * 4)
  console.log(JSON.stringify({ activeAcrossIdleWindows: true, idleClosed: true, idleMs, activeMs, stalledMs }))
} finally {
  for (const server of servers) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
  await delay(0)
}
