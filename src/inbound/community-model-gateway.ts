import type { IncomingMessage, ServerResponse } from 'node:http'
import { CommunityModelAccessError } from '../domain/community-model.js'
import type { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import type { CommunityModelUpstreamPort } from '../ports/community-model-upstream.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import { CommunityRequestError, readCommunityJson } from './community-request.js'
import { downstreamAbort, pipeUpstreamBody } from './upstream-stream.js'

const MAX_MODEL_BODY_BYTES = 16 * 1024 * 1024

/** Default route only, scoped by current identity; no vault, KEY or records dependencies. */
export function createCommunityModelGateway(deps: {
  readonly authorization: Pick<CommunityModelAuthorization, 'authorize'>
  readonly connections: Pick<SessionRegistryPort, 'track' | 'untrack'>
  readonly model: string
  readonly upstream?: CommunityModelUpstreamPort
}) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') { failure(response, 405, 'Use POST for default model requests'); return }
    const { controller, cleanup } = downstreamAbort(request, response)
    try {
      const username = deps.authorization.authorize(request.headers['x-api-key'])
      const body = await readCommunityJson(request, MAX_MODEL_BODY_BYTES)
      if (typeof body !== 'object' || body === null || Array.isArray(body)
        || (body as Record<string, unknown>).model !== deps.model) { failure(response, 403, 'Default model route is unavailable'); return }
      deps.authorization.authorize(request.headers['x-api-key'])
      if (response.destroyed || controller.signal.aborted) return
      if (deps.upstream === undefined) { failure(response, 503, 'Default model upstream credential is not configured'); return }
      deps.connections.track(username, request.socket)
      const upstream = await deps.upstream.sendMessages(JSON.stringify(body), request.headers.accept ?? 'text/event-stream', controller.signal)
      if (response.destroyed || controller.signal.aborted) { await upstream.body?.cancel(); return }
      // Account state may have changed while waiting for upstream response headers.
      try { deps.authorization.authorize(request.headers['x-api-key']) }
      catch (error) { controller.abort(); await upstream.body?.cancel(); throw error }
      if (!upstream.ok) {
        await upstream.body?.cancel()
        failure(response, 502, `Default model upstream rejected the request (HTTP ${upstream.status})`); return
      }
      response.writeHead(upstream.status, { 'cache-control': 'no-store',
        'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      await pipeUpstreamBody(response, upstream.body, controller)
    } catch (error) {
      if (response.destroyed) return
      if (response.headersSent) { response.destroy(); return }
      if (error instanceof CommunityModelAccessError) failure(response, error.kind === 'unauthenticated' ? 401 : 403, error.message)
      else if (error instanceof CommunityRequestError) failure(response, error.status, error.message)
      else failure(response, 502, 'Default model upstream is unavailable; retry or contact the deployer')
    } finally { cleanup(); deps.connections.untrack(request.socket) }
  }
}

function failure(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : 'api_error', message } }))
}
