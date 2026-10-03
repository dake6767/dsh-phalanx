import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { ProxyServer } from 'http-proxy-3'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import type { EntrySessionGate } from './platform-session.js'
import { stripPlatformCookie } from './platform-session.js'
import { MODEL_GATEWAY_PATH } from '../dsh/model-protocol.js'
import { sendText } from './http-response.js'

export function createPublicServer(deps: {
  readonly handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly connections: SessionRegistryPort
  readonly upgrade: Parameters<typeof attachUpgrade>[1]
}): Server {
  const server = createServer((request, response) => {
    void (async () => await deps.handle(request, response))().catch(error => {
      if (!response.headersSent) {
        if (error instanceof CommunityRuntimeUnavailableError) sendText(response, 503, 'Service Unavailable')
        else sendText(response, 500, 'Internal Server Error')
      } else response.destroy(error instanceof Error ? error : undefined)
    })
  })
  server.on('connection', socket => { deps.connections.registerConnection(socket, true) })
  attachUpgrade(server, deps.upgrade)
  return server
}

export function createGatewayOnlyServer(deps: {
  readonly connections: SessionRegistryPort
  readonly model: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly network: { readonly http: (request: IncomingMessage, response: ServerResponse) => Promise<void>, readonly connect: (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void> }
}): Server {
  const server = createServer((request, response) => {
    void (async () => {
      if (/^https?:\/\//iu.test(request.url ?? '')) {
        await deps.network.http(request, response)
        return
      }
      const url = new URL(request.url ?? '/', 'http://dsh-phalanx-gateway.invalid')
      if (url.pathname === MODEL_GATEWAY_PATH) await deps.model(request, response)
      else sendText(response, 404, 'Not Found')
    })().catch(error => {
      if (!response.headersSent) sendText(response, 500, 'Internal Server Error')
      else response.destroy(error instanceof Error ? error : undefined)
    })
  })
  server.on('connect', (request, socket, head) => {
    void (async () => await deps.network.connect(request, socket, head))().catch(() => { socket.destroy() })
  })
  server.on('connection', socket => { deps.connections.registerConnection(socket, false) })
  return server
}

export function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolveListen()
    })
  })
}

export function acceptsPublicHost(request: IncomingMessage, response: ServerResponse, origin: URL): boolean {
  if (request.headers.host === origin.host) return true
  response.writeHead(403, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
  response.end('Forbidden')
  return false
}

/** Host and fresh account identity checks for every WebSocket upgrade. */
export function attachUpgrade(server: Server, deps: {
  readonly origin: () => URL
  readonly recordsReady: () => boolean
  readonly session: EntrySessionGate
  readonly ensureRuntime: (userId: string, origin: URL) => Promise<CommunityUserInstance>
  readonly rememberCookie: (userId: string, header: string | undefined) => void
  readonly connections: SessionRegistryPort
  readonly proxy: Pick<ProxyServer, 'ws'>
}): void {
  server.on('upgrade', (request, socket, head) => {
    void (async () => {
      const origin = deps.origin()
      if (request.headers.host !== origin.host) { rejectUpgrade(socket, 403, 'Forbidden'); return }
      if (!deps.recordsReady()) { rejectUpgrade(socket, 503, 'Service Unavailable'); return }
      const userId = deps.session.authenticate(request)
      if (userId === undefined) { rejectUpgrade(socket, 401, 'Unauthorized'); return }
      const instance = await deps.ensureRuntime(userId, origin)
      if (!deps.session.current(request, userId)) {
        rejectUpgrade(socket, 401, 'Unauthorized')
        return
      }
      deps.rememberCookie(userId, request.headers.cookie)
      deps.connections.track(userId, request.socket)
      stripPlatformCookie(request)
      deps.proxy.ws(request, socket, head, { target: instance.origin }, error => { socket.destroy(error) })
    })().catch(error => {
      if (error instanceof CommunityRuntimeUnavailableError) rejectUpgrade(socket, 503, 'Service Unavailable')
      else socket.destroy(error instanceof Error ? error : undefined)
    })
  })
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}
