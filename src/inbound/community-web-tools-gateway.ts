import type { UsagePolicy } from '../use-cases/usage-policy.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { sendCommunityJson } from './community-errors.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { CommunityModelAccessError } from '../domain/community-model.js'
import { CommunityWebToolsError, communityWebToolsMessage } from '../domain/community-web-tools.js'
import type { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import type { CommunityWebToolsUpstreamPort, WebToolsOperation } from '../ports/community-web-tools.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import { CommunityRequestError, readCommunityJson } from './community-request.js'
import { downstreamAbort } from './upstream-stream.js'
import { DEEPSEEK_WEB_TOOLS_HOST, WEB_TOOLS_ORIGINAL_QUESTION_MAX_CHARS } from '../dsh/web-tools.js'

/** Retrieval request bodies are small; the bound rejects anything that is not one. */
export const WEB_TOOLS_MAX_BODY_BYTES = 64 * 1024
/** Backstop for the upstream retrieval call; the DSH tool keeps its own shorter policy. */
export const WEB_TOOLS_TIMEOUT_MS = 60_000
/** Search snippets and fetch Markdown stay well below this; refuse runaway responses. */
export const WEB_TOOLS_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Search query and fetch target bounds before forwarding. */
const MAX_QUERY_CHARS = 8192
const MAX_URL_CHARS = 4096

/**
 * Member-scoped retrieval gateway: authenticate the member token, sanitize one
 * DeepSeek Search or Fetch request, forward it with the platform credential,
 * and relay the normalized response. Usage metadata excludes retrieval content.
 */
export function createCommunityWebToolsGateway(deps: {
  readonly usage?: Pick<UsagePolicy, 'begin'>
  readonly authorization: Pick<CommunityModelAuthorization, 'authorize'>
  readonly connections: Pick<SessionRegistryPort, 'track' | 'untrack'>
  readonly upstream?: CommunityWebToolsUpstreamPort
  readonly timeoutMs?: number
}) {
  return async (request: IncomingMessage, response: ServerResponse, operation: WebToolsOperation): Promise<void> => {
    if (request.method !== 'POST') { failure(response, 405, 'Use POST for web retrieval requests'); return }
    const { controller, cleanup } = downstreamAbort(request, response)
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, deps.timeoutMs ?? WEB_TOOLS_TIMEOUT_MS)
    let username: string | undefined, denied = false
    let attempt: ReturnType<UsagePolicy['begin']> | undefined
    try {
      const token = bearerToken(request.headers.authorization)
      if (token === undefined) { failure(response, 401, 'Authentication is required'); return }
      try { username = deps.authorization.authorize(token, member => {
        attempt = deps.usage?.begin(member, { kind: 'web-tools', id: 'web-tools', operation })
        if (attempt && !attempt.allowed) throw new BusinessRuleError('forbidden', 'This use is not allowed.', 'usage-not-allowed')
      }) }
      catch (error) {
        if (error instanceof CommunityModelAccessError) {
          denied = true; failure(response, error.kind === 'unauthenticated' ? 401 : 403, error.message); return
        }
        throw error
      }
      const body = sanitizeRetrievalBody(operation, await readCommunityJson(request, WEB_TOOLS_MAX_BODY_BYTES))
      if (body === undefined) { failure(response, 400, 'Invalid web retrieval request'); return }
      if (deps.upstream === undefined) throw new CommunityWebToolsError('unconfigured')
      deps.connections.track(username, request.socket)
      const upstream = await deps.upstream.send(operation, JSON.stringify(body), controller.signal)
      // Account state may have changed while waiting for upstream headers.
      try { deps.authorization.authorize(token) }
      catch (error) { await upstream.body?.cancel(); throw error }
      if (!upstream.ok) {
        await upstream.body?.cancel()
        if (upstream.status === 401 || upstream.status === 403) throw new CommunityWebToolsError('credential-rejected')
        if (upstream.status === 429) { failure(response, 429, 'DeepSeek retrieval is rate limited. Retry the search or fetch later.'); return }
        failure(response, 502, `DeepSeek retrieval rejected the request (HTTP ${upstream.status})`)
        return
      }
      const text = await readBounded(upstream, controller.signal)
      if (text === undefined) throw new CommunityWebToolsError('upstream')
      if (!isJson(text)) throw new CommunityWebToolsError('upstream')
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json' })
      response.end(text)
    } catch (error) {
      denied = error instanceof CommunityModelAccessError || error instanceof BusinessRuleError
      if (response.destroyed) return
      if (response.headersSent) { response.destroy(); return }
      if (error instanceof BusinessRuleError) { sendCommunityJson(response, 403, { code: error.code, error: error.message }); return }
      if (error instanceof CommunityWebToolsError) {
        failure(response, webToolsStatus(error.kind), communityWebToolsMessage(error.kind, DEEPSEEK_WEB_TOOLS_HOST))
        return
      }
      if (error instanceof CommunityRequestError) { failure(response, error.status, error.message); return }
      if (timedOut) { failure(response, 504, communityWebToolsMessage('timeout')); return }
      if (controller.signal.aborted) return
      if (error instanceof CommunityModelAccessError) { failure(response, error.kind === 'unauthenticated' ? 401 : 403, error.message); return }
      failure(response, 502, communityWebToolsMessage('upstream'))
    } finally {
      clearTimeout(timer)
      if (username !== undefined) deps.connections.untrack(request.socket)
      cleanup()
      try { attempt?.finish({ outcome: denied ? 'denied' : response.writableEnded && response.statusCode < 400 && !controller.signal.aborted ? 'succeeded' : 'failed', httpStatus: response.statusCode,
        ...(denied ? { reason: 'access' as const } : controller.signal.aborted && !timedOut ? { reason: 'cancelled' as const } : response.statusCode >= 400 ? { reason: 'transport' as const } : {}) }) }
      catch { console.warn('Usage record could not be saved') }
    }
  }
}

/** HTTP status for each typed retrieval failure. */
function webToolsStatus(kind: CommunityWebToolsError['kind']): number {
  switch (kind) {
    case 'unconfigured': return 503
    case 'credential-rejected':
    case 'upstream': return 502
    case 'timeout': return 504
  }
}

/** Only a `Bearer` token from the member process is accepted; the key never arrives here. */
function bearerToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string') return undefined
  const match = /^Bearer[ ]+([^\s]+)$/u.exec(header)
  return match?.[1]
}

/** One DeepSeek retrieval body reduced to its documented fields. */
interface SanitizedSearch { query: string, count?: number, need_content: false, ori_question?: string }
interface SanitizedFetch { url: string }

/**
 * Drop undocumented fields and enforce local bounds before the platform
 * credential is attached. Unknown fields are ignored for forward compatibility.
 * @returns the body to forward, or undefined when the request is not one.
 */
function sanitizeRetrievalBody(operation: WebToolsOperation, value: unknown): SanitizedSearch | SanitizedFetch | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const body = value as Record<string, unknown>
  if (operation === 'search') {
    if (typeof body.query !== 'string') return undefined
    const query = body.query.trim()
    if (query.length === 0 || query.length > MAX_QUERY_CHARS) return undefined
    const count = body.count === undefined ? undefined
      : Number.isInteger(body.count) && (body.count as number) >= 1 && (body.count as number) <= 50 ? body.count as number : undefined
    if (body.count !== undefined && count === undefined) return undefined
    const question = typeof body.ori_question === 'string'
      ? Array.from(body.ori_question.replace(/\s+/gu, ' ').trim()).slice(0, WEB_TOOLS_ORIGINAL_QUESTION_MAX_CHARS).join('')
      : ''
    // The DSH provider always asks for snippets only; keep that fixed so the platform contract matches the plugin default.
    return { query, ...(count === undefined ? {} : { count }), need_content: false, ...(question.length === 0 ? {} : { ori_question: question }) }
  }
  if (typeof body.url !== 'string' || body.url.length > MAX_URL_CHARS) return undefined
  let target: URL
  try { target = new URL(body.url) } catch { return undefined }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return undefined
  return { url: target.href }
}

/** Read the upstream JSON body without buffering more than the response bound. */
async function readBounded(upstream: Response, signal: AbortSignal): Promise<string | undefined> {
  if (upstream.body === null) return ''
  const chunks: Uint8Array[] = []
  let bytes = 0
  for await (const chunk of upstream.body) {
    if (signal.aborted) throw new CommunityWebToolsError('timeout')
    bytes += chunk.byteLength
    if (bytes > WEB_TOOLS_MAX_RESPONSE_BYTES) return undefined
    chunks.push(chunk)
  }
  return Buffer.concat(chunks.map(chunk => Buffer.from(chunk))).toString('utf8')
}

function isJson(text: string): boolean {
  try { JSON.parse(text) as unknown; return true }
  catch { return false }
}

function failure(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : 'api_error', message } }))
}
