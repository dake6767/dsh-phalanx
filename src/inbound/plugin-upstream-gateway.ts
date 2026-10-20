import type { UsagePolicy } from '../use-cases/usage-policy.js'
import type { UsageResult } from '../domain/usage-record.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { sendCommunityJson } from './community-errors.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { PluginUpstreamAccessError, PluginUpstreamTransportError, PLUGIN_TIMEOUT_MS } from '../domain/plugin-upstream.js'
import type { PluginUpstreamAccess } from '../use-cases/plugin-upstream-access.js'
import type { PluginUpstreamTransportPort } from '../ports/plugin-upstreams.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import { downstreamAbort, pipeUpstreamBody } from './upstream-stream.js'

export function createPluginUpstreamGateway(deps: { readonly access: Pick<PluginUpstreamAccess, 'authorize'>,
  readonly usage?: Pick<UsagePolicy, 'begin'>, readonly transport: PluginUpstreamTransportPort, readonly connections: Pick<SessionRegistryPort, 'track' | 'untrack'> }) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const { controller, cleanup } = downstreamAbort(request, response)
    let attempt: ReturnType<UsagePolicy['begin']> | undefined
    let result: UsageResult = { outcome: 'failed', reason: 'transport' }
    try {
      // Parse the raw request target: URL normalization would change dot segments and escaped paths.
      const match = /^\/plugins\/([^/]+)\/([^/?]+)(\/[^#]*|\?[^#]*)?$/u.exec(request.url ?? '')
      if (!match) { failure(response, 404, 'Plugin upstream was not found'); return }
      let packageName: string, name: string
      try { packageName = decodeURIComponent(match[1]!); name = decodeURIComponent(match[2]!) }
      catch { failure(response, 404, 'Plugin upstream was not found'); return }
      const headers: Record<string, string[]> = Object.create(null) as Record<string, string[]>
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const key = request.rawHeaders[index]!.toLowerCase()
        ;(headers[key] ??= []).push(request.rawHeaders[index + 1]!)
      }
      const admitted = deps.access.authorize(packageName, name, headers, member => {
        attempt = deps.usage?.begin(member, { kind: 'plugin-upstream', id: packageName, operation: name })
        if (attempt && !attempt.allowed) throw new BusinessRuleError('forbidden', 'This use is not allowed.', 'usage-not-allowed')
      })
      deps.connections.track(admitted.username, request.socket)
      const suffix = match[3] ?? '/'
      const upstream = await deps.transport.send({ upstream: admitted.upstream, path: suffix.startsWith('?') ? `/${suffix}` : suffix,
        method: request.method ?? 'GET', headers: request.headers,
        body: Readable.toWeb(request) as ReadableStream<Uint8Array>, signal: controller.signal })
      deps.access.authorize(packageName, name, headers)
      if (controller.signal.aborted) { result = { outcome: 'failed', reason: 'cancelled' }; await upstream.body?.cancel(); return }
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers))
      const complete = await pipeUpstreamBody(response, upstream.body, controller, PLUGIN_TIMEOUT_MS)
      result = { outcome: complete && upstream.status < 400 ? 'succeeded' : 'failed', httpStatus: upstream.status, ...(!complete ? { reason: 'cancelled' as const } : {}) }
    } catch (error) {
      result = error instanceof PluginUpstreamAccessError ? { outcome: 'denied', reason: 'access', httpStatus: error.status }
        : error instanceof BusinessRuleError ? { outcome: 'denied', reason: 'policy', httpStatus: 403 }
          : { outcome: 'failed', reason: controller.signal.aborted ? 'cancelled' : 'transport', httpStatus: error instanceof PluginUpstreamTransportError ? error.status : 502 }
      controller.abort()
      if (response.destroyed) return
      if (response.headersSent) { response.destroy(); return }
      if (error instanceof BusinessRuleError) sendCommunityJson(response, 403, { code: error.code, error: error.message })
      else if (error instanceof PluginUpstreamAccessError || error instanceof PluginUpstreamTransportError) failure(response, error.status, error.message)
      else failure(response, 502, 'Plugin upstream is unavailable')
    } finally { cleanup(); deps.connections.untrack(request.socket); try { attempt?.finish(result) } catch { console.warn('Usage record could not be saved') } }
  }
}
function failure(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : 'api_error', message } }))
}
