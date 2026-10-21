import type { UsageMember } from '../domain/usage-record.js'
import type { UsagePolicy } from '../use-cases/usage-policy.js'
import { modelUsageObserver } from '../dsh/model-protocol.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CommunityModelAccessError, CommunityModelRouteError } from '../domain/community-model.js'
import { admitCommunityModel, type CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import type { CommunityModelUpstreamPort } from '../ports/community-model-upstream.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import { CommunityRequestError, readCommunityJson } from './community-request.js'
import { downstreamAbort, pipeUpstreamBody } from './upstream-stream.js'

const MAX_MODEL_BODY_BYTES = 16 * 1024 * 1024

/** Default route only, scoped by current identity; no vault or KEY dependencies. */
export function createCommunityModelGateway(deps: {
  readonly usage?: Pick<UsagePolicy, 'begin'>
  readonly authorization: Pick<CommunityModelAuthorization, 'authorize'> & Partial<Pick<CommunityModelAuthorization, 'version'>>
  readonly connections: Pick<SessionRegistryPort, 'track' | 'untrack'>
  readonly model?: string
  readonly upstream?: CommunityModelUpstreamPort
}) {
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') { failure(response, 405, 'Use POST for default model requests'); return }
    const { controller, cleanup } = downstreamAbort(request, response)
    let member: UsageMember | undefined, attempt: ReturnType<UsagePolicy['begin']> | undefined, observer: ReturnType<typeof modelUsageObserver> | undefined, completed = false, denied = false
    try {
      let username: string | undefined, accessError: unknown, admission: ReturnType<typeof admitCommunityModel> | undefined
      try { admission = admitCommunityModel(deps.authorization, request.headers['x-api-key'], value => { member = value }); username = admission.username }
      catch (error) { if (!member) throw error; accessError = error }
      let body: unknown
      try { body = await readCommunityJson(request, MAX_MODEL_BODY_BYTES) } catch (error) { throw accessError ?? error }
      if (typeof body !== 'object' || body === null || Array.isArray(body)
        || typeof (body as Record<string, unknown>).model !== 'string'
        || (deps.model !== undefined && (body as Record<string, unknown>).model !== deps.model)) { if (accessError) throw accessError; failure(response, 403, 'Default model route is unavailable'); return }
      if (member) attempt = deps.usage?.begin(member, { kind: 'model', id: (body as Record<string, unknown>).model as string, operation: 'messages' })
      if (accessError) throw accessError
      admission!.current()
      if (response.destroyed || controller.signal.aborted) return
      if (attempt && !attempt.allowed) { denied = true; failure(response, 402, 'This use is not allowed.', 'usage-not-allowed'); return }
      if (deps.upstream === undefined) { failure(response, 503, 'Shared models are not configured. Ask an administrator to configure a provider in Model settings.'); return }
      deps.connections.track(username!, request.socket)
      const upstream = await deps.upstream.sendMessages(body as Record<string, unknown>, request.headers.accept ?? 'text/event-stream', controller.signal)
      if (response.destroyed || controller.signal.aborted) { await upstream.body?.cancel(); return }
      // Account state may have changed while waiting for upstream response headers.
      try { admission!.current() }
      catch (error) { controller.abort(); await upstream.body?.cancel(); throw error }
      if (!upstream.ok) {
        await upstream.body?.cancel()
        failure(response, 502, `Default model upstream rejected the request (HTTP ${upstream.status})`); return
      }
      observer = modelUsageObserver(upstream.headers.get('content-type') ?? 'application/json')
      response.writeHead(upstream.status, { 'cache-control': 'no-store',
        'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      completed = await pipeUpstreamBody(response, upstream.body, controller, undefined, observer.observe)
    } catch (error) {
      denied = error instanceof CommunityModelAccessError
      if (response.destroyed) return
      if (response.headersSent) { response.destroy(); return }
      if (error instanceof CommunityModelAccessError) failure(response, error.kind === 'unauthenticated' ? 401 : 403, error.message)
      else if (error instanceof CommunityModelRouteError) failure(response, error.kind === 'unconfigured' ? 503 : 403, error.message)
      else if (error instanceof CommunityRequestError) failure(response, error.status, error.message)
      else failure(response, 502, 'Default model upstream is unavailable; retry or contact the deployer')
    } finally {
      cleanup(); deps.connections.untrack(request.socket)
      try { attempt?.finish({ outcome: denied ? 'denied' : completed ? 'succeeded' : 'failed', ...(observer?.finish() ?? {}) }) }
      catch { console.warn('Usage record could not be saved') }
    }
  }
}

function failure(response: ServerResponse, status: number, message: string, code?: string): void {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ type: 'error', ...(code === undefined ? {} : { code }), error: { type: status === 401 ? 'authentication_error' : status === 402 || status === 403 ? 'permission_error' : 'api_error', message } }))
}
