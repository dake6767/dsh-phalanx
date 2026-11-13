import type { IncomingMessage, ServerResponse } from 'node:http'
import { PluginUpstreamAccessError, PluginUpstreamTransportError } from '../domain/plugin-upstream.js'
import type { UsageResult } from '../domain/usage-record.js'
import type { PluginUpstreamTransportPort } from '../ports/plugin-upstreams.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import { NATIVE_PLUGIN_SERVICE_PATH, type NativePluginServiceAccess } from '../use-cases/native-plugin-service-access.js'
import type { UsagePolicy } from '../use-cases/usage-policy.js'
import { sendCommunityJson } from './community-errors.js'
import { CommunityRequestError, readCommunityJson } from './community-request.js'
import { downstreamAbort } from './upstream-stream.js'

export const NATIVE_SERVICE_BODY_LIMIT = 32 * 1024 * 1024
export const NATIVE_SERVICE_TIMEOUT_MS = 180_000

class PluginServiceHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function createNativePluginServiceGateway(deps: {
  readonly access: Pick<NativePluginServiceAccess, 'authenticate' | 'register'>
  readonly transport: PluginUpstreamTransportPort
  readonly connections: Pick<SessionRegistryPort, 'track' | 'untrack'>
  readonly usage?: Pick<UsagePolicy, 'begin'>
}) {
  return async (request: IncomingMessage, response: ServerResponse) => {
    const { controller, cleanup } = downstreamAbort(request, response)
    const deadline = AbortSignal.timeout(NATIVE_SERVICE_TIMEOUT_MS)
    const signal = AbortSignal.any([controller.signal, deadline])
    let attempt: ReturnType<UsagePolicy['begin']> | undefined
    let result: UsageResult = { outcome: 'failed', reason: 'transport' }
    let tracked = false
    try {
      const { scope, operation } = target(request.url)
      if (request.method !== 'POST') throw new PluginServiceHttpError(405, 'Plugin services accept POST only')
      const authorization = request.headersDistinct.authorization
      const token = authorization?.length === 1 ? /^Bearer ([A-Za-z0-9_-]{43})$/iu.exec(authorization[0]!)?.[1] : undefined
      if (!token || request.headersDistinct['x-api-key']) throw new PluginUpstreamAccessError(401, 'A valid plugin service token is required')
      await deps.access.authenticate(scope, token)
      if (Number(request.headers['content-length']) > NATIVE_SERVICE_BODY_LIMIT)
        throw new PluginUpstreamTransportError(413, 'Plugin request body exceeds 32 MiB')
      const body = await readCommunityJson(request, NATIVE_SERVICE_BODY_LIMIT, signal)
      const grant = await deps.access.register(scope, token, signal, (current, onAbort) => {
        const expected = current.protocol === 'openai-chat' ? 'chat/completions' : 'images/generations'
        if (operation !== expected) throw new PluginUpstreamAccessError(404, 'Plugin service operation was not found')
        if (!requestMatches(body, current.model, current.protocol))
          throw new PluginServiceHttpError(400, 'Request does not match the configured plugin service')
        attempt = deps.usage?.begin(
          { username: current.username, groupId: current.groupId },
          { kind: 'plugin-upstream', id: scope.packageName, operation: scope.slot },
        )
        if (attempt && !attempt.allowed) throw new PluginUpstreamAccessError(403, 'This use is not allowed')
        if (request.socket.destroyed) throw Error('Plugin connection closed')
        onAbort(() => {
          deps.connections.untrack(response)
          tracked = false
        })
        deps.connections.track(current.username, response)
        tracked = true
        return current
      })
      signal.throwIfAborted()
      const bytes = Buffer.from(JSON.stringify(body))
      const upstream = await deps.transport.send({
        upstream: grant.upstream,
        path: '/' + operation,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(bytes.length), accept: 'application/json' },
        body: new ReadableStream({
          start(stream) {
            stream.enqueue(bytes)
            stream.close()
          },
        }),
        signal,
      })
      if (!upstream.ok) {
        await upstream.body?.cancel()
        throw new PluginServiceHttpError(
          upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502,
          'The configured provider could not complete this request',
        )
      }
      const payload = await resultBody(upstream, grant.upstream.credential)
      signal.throwIfAborted()
      sendCommunityJson(response, upstream.status, payload)
      result = { outcome: 'succeeded', httpStatus: upstream.status }
    } catch (error) {
      const status = deadline.aborted
        ? 504
        : error instanceof PluginUpstreamAccessError ||
            error instanceof PluginUpstreamTransportError ||
            error instanceof CommunityRequestError ||
            error instanceof PluginServiceHttpError
          ? error.status
          : 502
      const message = deadline.aborted
        ? 'Plugin service timed out'
        : error instanceof PluginUpstreamAccessError ||
            error instanceof PluginUpstreamTransportError ||
            error instanceof CommunityRequestError ||
            error instanceof PluginServiceHttpError
          ? error.message
          : 'Plugin service is unavailable'
      result = {
        outcome: error instanceof PluginUpstreamAccessError && (status === 401 || status === 403) ? 'denied' : 'failed',
        httpStatus: status,
        reason: status === 401 || status === 403 ? 'access' : 'transport',
      }
      if (!response.destroyed && !response.headersSent) {
        if (!request.complete) response.setHeader('connection', 'close')
        sendCommunityJson(response, status, { error: { message } })
      }
    } finally {
      controller.abort()
      cleanup()
      if (tracked) deps.connections.untrack(response)
      try {
        await attempt?.finish(result)
      } catch {
        console.warn('Usage record could not be saved')
      }
    }
  }
}

function target(raw: string | undefined) {
  const parts = raw?.startsWith(NATIVE_PLUGIN_SERVICE_PATH) ? raw.slice(NATIVE_PLUGIN_SERVICE_PATH.length).split('/') : []
  if (parts.length !== 7 || parts.some(part => !part) || !['chat/completions', 'images/generations'].includes(parts.slice(5).join('/')))
    throw new PluginUpstreamAccessError(404, 'Plugin service operation was not found')
  try {
    const [username, packageName, slot, backend] = parts.slice(0, 4).map(decodeURIComponent) as [string, string, string, string]
    const binding = parts[4]!
    if (!/^[A-Za-z0-9_-]{43}$/u.test(binding)) throw Error()
    return { scope: { username, packageName, slot, backend, binding }, operation: parts.slice(5).join('/') }
  } catch {
    throw new PluginUpstreamAccessError(404, 'Plugin service operation was not found')
  }
}

function requestMatches(body: unknown, model: string, protocol: import('../use-cases/native-plugin-service-access.js').NativePluginServiceProtocol) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('model' in body) || body.model !== model || ('stream' in body && body.stream !== false))
    return false
  if (protocol === 'openai-chat') return 'messages' in body && Array.isArray(body.messages)
  return 'prompt' in body && typeof body.prompt === 'string' && (protocol === 'seedream-image' || !('image' in body))
}

async function resultBody(response: Response, credential: string): Promise<object> {
  const invalid = () => new PluginUpstreamTransportError(502, 'The configured provider returned an invalid response')
  if (!response.body || response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw invalid()
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.byteLength
    if (length > NATIVE_SERVICE_BODY_LIMIT) throw invalid()
    chunks.push(Buffer.from(chunk))
  }
  const text = Buffer.concat(chunks, length).toString('utf8')
  try {
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
    const serialized = JSON.stringify(value)
    const literal = JSON.stringify(credential).slice(1, -1)
    if (serialized.includes(literal)) throw invalid()
    // Upstream URLs can reflect credentials using either case of percent escapes.
    const decoded = serialized.replace(/%([0-9a-f]{2})/giu, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
    if (decoded.includes(literal) || decoded.includes(credential)) throw invalid()
    return value
  } catch {
    throw invalid()
  }
}
