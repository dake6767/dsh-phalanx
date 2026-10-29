import type { IncomingMessage, ServerResponse } from 'node:http'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityModelAccessError } from '../domain/community-model.js'
import { memberMcpLaunchConfiguration } from '../dsh/member-mcp.js'
import { admitCommunityModel, type CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import type { McpServices } from '../use-cases/mcp-services.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import { downstreamAbort } from './upstream-stream.js'

/** Launch input is returned only to this current member, after final database registration. */
export function createMcpMemberConfiguration(deps: {
  authorization: Pick<CommunityModelAuthorization, 'authorize' | 'register'>
  services: Pick<McpServices, 'effective' | 'captureLocalPolicy'> & Partial<Pick<McpServices, 'accessible' | 'diagnostic'>>
  connections: Pick<SessionRegistryPort, 'track' | 'untrack'>
}) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const { controller, cleanup } = downstreamAbort(request, response)
    const fail = (status: number) => {
      response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify({ error: 'Member MCP configuration unavailable' }))
    }
    try {
      const match = /^\/mcp-member(-test)?\/(p-[A-Za-z0-9_-]{1,30})\?generation=([1-9][0-9]*)$/u.exec(request.url ?? '')
      if (!match) {
        fail(404)
        return
      }
      if (request.method !== 'GET') {
        fail(405)
        return
      }
      const diagnostic = Boolean(match[1]),
        name = match[2]!,
        generation = Number(match[3])
      if (!Number.isSafeInteger(generation)) {
        fail(404)
        return
      }
      const headers = request.rawHeaders.filter((_value, index) => index % 2 === 0 && request.rawHeaders[index]!.toLowerCase() === 'authorization')
      const token = headers.length === 1 ? /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(request.headers.authorization ?? '')?.[1] : undefined
      const assertCurrent = deps.services.captureLocalPolicy()
      const admission = await admitCommunityModel(deps.authorization, token)
      const service = diagnostic
        ? await deps.services.diagnostic?.(admission.username, name)
        : ((await deps.services.accessible?.(admission.username)) ?? (await deps.services.effective(admission.username))).find(row => row.name === name)
      if (!service) throw new CommunityModelAccessError('forbidden')
      if (service.run?.location !== 'member' || !service.prepared || service.generation !== generation) {
        fail(404)
        return
      }
      const configuration = memberMcpLaunchConfiguration(service, diagnostic)
      const registered = await admission.register((username, onAbort) => {
        assertCurrent()
        if (response.destroyed || controller.signal.aborted) return false
        onAbort(() => {
          controller.abort()
          deps.connections.untrack(request.socket)
          request.socket.destroy()
        })
        deps.connections.track(username, request.socket)
        return true
      })
      if (!registered || response.destroyed || controller.signal.aborted) return
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      response.end(JSON.stringify(configuration))
    } catch (error) {
      if (response.destroyed) return
      if (response.headersSent) {
        response.destroy()
        return
      }
      fail(
        error instanceof CommunityModelAccessError
          ? error.kind === 'unauthenticated'
            ? 401
            : 403
          : error instanceof BusinessRuleError
            ? error.kind === 'forbidden'
              ? 403
              : 404
            : 502,
      )
    } finally {
      cleanup()
      deps.connections.untrack(request.socket)
    }
  }
}
