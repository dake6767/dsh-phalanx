import { monitorRuntimeProxy } from './proxy-error.js'
import { SKILL_USAGE_PATH } from '../dsh/skill-usage.js'
import type { CommunityMaintenancePort } from '../ports/community-maintenance.js'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { ProxyServer } from 'http-proxy-3'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import type { EntrySessionGate } from './platform-session.js'
import { stripPlatformCookie } from './platform-session.js'
import { MODEL_GATEWAY_PATH } from '../dsh/model-protocol.js'
import { webToolsOperationForPath } from '../dsh/web-tools.js'
import type { WebToolsOperation } from '../ports/community-web-tools.js'
import { assertCommunityOrigin } from './community-request.js'
import { sendText } from './http-response.js'

export function createPublicServer(deps: {
  readonly requestScope?: <T>(operation: () => T) => T
  readonly handle: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly connections: SessionRegistryPort
  readonly upgrade: Parameters<typeof attachUpgrade>[1]
}): Server {
  const server = createServer((request, response) => {
    const handle = () => deps.handle(request, response)
    void (deps.requestScope ? deps.requestScope(handle) : handle()).catch(error => {
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
  readonly usageReports?: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly contributions?: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly execution?: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly mcp?: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly pluginUpstreams?: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly maintenance?: CommunityMaintenancePort
  readonly connections: SessionRegistryPort
  readonly model: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly webTools?: (request: IncomingMessage, response: ServerResponse, operation: WebToolsOperation) => Promise<void>
  readonly network: { readonly http: (request: IncomingMessage, response: ServerResponse) => Promise<void>, readonly connect: (request: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void> }
}): Server {
  const server = createServer((request, response) => {
    void (async () => {
      if (deps.maintenance?.closed() === true) { sendText(response, 503, 'System upgrade in progress'); return }
      if (/^https?:\/\//iu.test(request.url ?? '')) {
        await deps.network.http(request, response)
        return
      }
      const url = new URL(request.url ?? '/', 'http://dsh-phalanx-gateway.invalid')
      const webTools = webToolsOperationForPath(url.pathname)
      if (url.pathname === SKILL_USAGE_PATH && deps.usageReports) await deps.usageReports(request, response)
      else if (url.pathname === '/contributions' && deps.contributions) await deps.contributions(request, response)
      else if (url.pathname === '/execution' && deps.execution) await deps.execution(request, response)
      else if ((url.pathname.startsWith('/mcp/') || url.pathname.startsWith('/mcp-test/')) && deps.mcp) await deps.mcp(request, response)
      else if (url.pathname.startsWith('/plugins/') && deps.pluginUpstreams) await deps.pluginUpstreams(request, response)
      else if (url.pathname === MODEL_GATEWAY_PATH) await deps.model(request, response)
      else if (webTools !== undefined && deps.webTools) await deps.webTools(request, response, webTools)
      else sendText(response, 404, 'Not Found')
    })().catch(error => {
      if (!response.headersSent) sendText(response, 500, 'Internal Server Error')
      else response.destroy(error instanceof Error ? error : undefined)
    })
  })
  server.requestTimeout = 0
  server.on('connect', (request, socket, head) => {
    void (async () => {
      if (deps.maintenance?.closed() === true) { rejectUpgrade(socket, 503, 'Service Unavailable'); return }
      await deps.network.connect(request, socket, head)
    })().catch(() => { socket.destroy() })
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
  readonly requestScope?: <T>(operation: () => T) => T
  readonly maintenance?: CommunityMaintenancePort
  readonly origin: () => URL
  readonly recordsReady: () => boolean
  readonly session: EntrySessionGate
  readonly checkRuntime?: (instance: CommunityUserInstance) => Promise<void>
  readonly ensureRuntime: (userId: string, origin: URL) => Promise<CommunityUserInstance>
  readonly rememberCookie: (userId: string, header: string | undefined) => void
  readonly connections: SessionRegistryPort
  readonly runtimeMount?: (userId: string) => string
  readonly proxy: Pick<ProxyServer, 'ws'>
}): void {
  server.on('upgrade', (request, socket, head) => {
    const upgrade = async () => {
      if (deps.maintenance?.closed() === true) { rejectUpgrade(socket, 503, 'Service Unavailable'); return }
      const origin = deps.origin()
      try { assertCommunityOrigin(request, origin) } catch { rejectUpgrade(socket, 403, 'Forbidden'); return }
      if (request.headers.host !== origin.host) { rejectUpgrade(socket, 403, 'Forbidden'); return }
      if (!deps.recordsReady()) { rejectUpgrade(socket, 503, 'Service Unavailable'); return }
      const userId = deps.session.authenticate(request)
      if (userId === undefined) { rejectUpgrade(socket, 401, 'Unauthorized'); return }
      const mount = deps.runtimeMount?.(userId)
      if (mount !== undefined) {
        const url = new URL(request.url ?? '/', origin)
        if (!url.pathname.startsWith(mount)) { rejectUpgrade(socket, 403, 'Forbidden'); return }
        request.url = `/${url.pathname.slice(mount.length)}${url.search}`
      }
      const instance = await deps.ensureRuntime(userId, origin)
      if (deps.maintenance?.closed() === true) { rejectUpgrade(socket, 503, 'Service Unavailable'); return }
      if (!deps.session.current(request, userId)) {
        rejectUpgrade(socket, 401, 'Unauthorized')
        return
      }
      deps.rememberCookie(userId, request.headers.cookie)
      deps.connections.track(userId, request.socket)
      stripPlatformCookie(request)
      const failed = monitorRuntimeProxy(request, instance, deps.checkRuntime)
      deps.proxy.ws(request, socket, head, { target: instance.origin }, error => { failed(error); socket.destroy(error) })
    }
    void (deps.requestScope ? deps.requestScope(upgrade) : upgrade()).catch(error => {
      if (error instanceof CommunityRuntimeUnavailableError) rejectUpgrade(socket, 503, 'Service Unavailable')
      else socket.destroy(error instanceof Error ? error : undefined)
    })
  })
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.end(`HTTP/1.1 ${String(status)} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}
