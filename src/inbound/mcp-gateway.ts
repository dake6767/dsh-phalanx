import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { CommunityModelAccessError } from '../domain/community-model.js'
import { PluginUpstreamTransportError, PLUGIN_TIMEOUT_MS } from '../domain/plugin-upstream.js'
import type { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import type { McpServices } from '../use-cases/mcp-services.js'
import type { PluginUpstreamTransportPort } from '../ports/plugin-upstreams.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import { downstreamAbort, pipeUpstreamBody } from './upstream-stream.js'

/** Every MCP exchange uses the member token and the current effective service set. */
export function createMcpGateway(deps: { authorization: Pick<CommunityModelAuthorization, 'authorize'>,
  services: Pick<McpServices, 'effective'>, transport: PluginUpstreamTransportPort,
  idleTimeoutMs?: number, connections: Pick<SessionRegistryPort, 'track' | 'untrack'> }) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const { controller, cleanup } = downstreamAbort(request, response)
    try {
      const match = /^\/mcp\/(p-[A-Za-z0-9_-]{1,30})(?:\?generation=[1-9][0-9]*)?$/u.exec(request.url ?? '')
      if (!match) { failure(response, 404); return }
      if (!['POST', 'GET', 'DELETE'].includes(request.method ?? '')) { failure(response, 405); return }
      const authHeaders = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === 'authorization')
      const token = authHeaders.length === 1 ? /^Bearer ([A-Za-z0-9_-]+)$/u.exec(request.headers.authorization ?? '')?.[1] : undefined
      const authorize = () => {
        const username = deps.authorization.authorize(token)
        const service = deps.services.effective(username).find(row => row.name === match[1])
        if (!service) throw new CommunityModelAccessError('forbidden')
        return { username, service }
      }
      const { username, service } = authorize()
      deps.connections.track(username, request.socket)
      const upstream = await deps.transport.send({ upstream: { name: service.name, baseUrl: service.url, credential: '', headers: [] }, path: null,
        method: request.method!, headers: request.headers, body: Readable.toWeb(request) as ReadableStream<Uint8Array>, signal: controller.signal })
      try { authorize() } catch (error) { controller.abort(); await upstream.body?.cancel(); throw error }
      if (controller.signal.aborted) { await upstream.body?.cancel(); return }
      response.writeHead(upstream.status, { ...Object.fromEntries(upstream.headers), 'cache-control': 'no-store' })
      await pipeUpstreamBody(response, upstream.body, controller, deps.idleTimeoutMs ?? PLUGIN_TIMEOUT_MS)
    } catch (error) {
      controller.abort()
      if (response.destroyed) return
      if (response.headersSent) { response.destroy(); return }
      failure(response, error instanceof CommunityModelAccessError ? error.kind === 'unauthenticated' ? 401 : 403 : error instanceof PluginUpstreamTransportError ? error.status : 502)
    } finally { cleanup(); deps.connections.untrack(request.socket) }
  }
}
function failure(response: ServerResponse, status: number): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify({ error: status === 401 ? 'MCP authentication required' : status === 403 ? 'MCP service is not enabled for this member' : 'MCP service unavailable' }))
}
