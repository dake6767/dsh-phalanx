import type { IncomingMessage, ServerResponse } from 'node:http'
import { PluginUpstreamAccessError, PluginUpstreamTransportError, type PluginUpstream } from '../domain/plugin-upstream.js'
import type { UsageResult } from '../domain/usage-record.js'
import type { PluginUpstreamTransportPort } from '../ports/plugin-upstreams.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import { NATIVE_PLUGIN_SERVICE_PATH, type NativePluginServiceAccess } from '../use-cases/native-plugin-service-access.js'
import type { UsagePolicy } from '../use-cases/usage-policy.js'
import { sendCommunityJson } from './community-errors.js'
import { CommunityRequestError, readCommunityBytes, readCommunityJson } from './community-request.js'
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
      const editing = operation === 'images/edits'
      const contentType = editing ? (request.headers['content-type'] ?? '') : 'application/json'
      const bytes = editing ? await readCommunityBytes(request, 'multipart/form-data', NATIVE_SERVICE_BODY_LIMIT, signal) : undefined
      const body = bytes ? await readImageEdit(bytes, contentType) : await readCommunityJson(request, NATIVE_SERVICE_BODY_LIMIT, signal)
      const grant = await deps.access.register(scope, token, signal, (current, onAbort) => {
        const expected = current.protocol === 'openai-chat' ? 'chat/completions' : 'images/generations'
        if (operation !== expected && !(editing && current.multipartEdits)) throw new PluginUpstreamAccessError(404, 'Plugin service operation was not found')
        if (!(body instanceof FormData ? imageEditMatches(body, current.model) : requestMatches(body, current.model, current.protocol)))
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
      const outgoing = body instanceof FormData ? new Response(body) : undefined
      const payloadBytes = outgoing ? Buffer.from(await outgoing.arrayBuffer()) : Buffer.from(JSON.stringify(body))
      signal.throwIfAborted()
      const upstream = await deps.transport.send({
        upstream: grant.upstream,
        path: '/' + operation,
        method: 'POST',
        headers: {
          'content-type': outgoing?.headers.get('content-type') ?? 'application/json',
          'content-length': String(payloadBytes.length),
          accept: 'application/json',
        },
        body: new ReadableStream({
          start(stream) {
            stream.enqueue(payloadBytes)
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
      const payload = await resultBody(upstream, grant.upstream)
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
  if (parts.length !== 7 || parts.some(part => !part) || !['chat/completions', 'images/generations', 'images/edits'].includes(parts.slice(5).join('/')))
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

async function readImageEdit(bytes: Buffer, contentType: string): Promise<FormData> {
  try {
    return await new Response(new Uint8Array(bytes), { headers: { 'content-type': contentType } }).formData()
  } catch {
    throw new PluginServiceHttpError(400, 'Invalid multipart image edit request')
  }
}

function imageEditMatches(form: FormData, model: string): boolean {
  if (form.get('model') !== model) return false
  const prompt = form.get('prompt')
  if (typeof prompt !== 'string' || !prompt.trim()) return false
  const images = [...form.getAll('image'), ...form.getAll('image[]')]
  if (!images.length || images.some(image => typeof image === 'string' || !image.size || !image.type.startsWith('image/'))) return false
  const fields = ['model', 'prompt', 'size', 'quality', 'response_format']
  return [...form].every(
    ([name, value]) => name === 'image' || name === 'image[]' || (fields.includes(name) && typeof value === 'string' && form.getAll(name).length === 1),
  )
}

function requestMatches(body: unknown, model: string, protocol: import('../use-cases/native-plugin-service-access.js').NativePluginServiceProtocol) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || !('model' in body) || body.model !== model || ('stream' in body && body.stream !== false))
    return false
  if (protocol === 'openai-chat') return 'messages' in body && Array.isArray(body.messages)
  return 'prompt' in body && typeof body.prompt === 'string' && (protocol === 'seedream-image' || !('image' in body))
}

const decodePercentEscapes = (text: string) => text.replace(/%([0-9a-f]{2})/giu, (_escape, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))

function hasPngImageData(bytes: Buffer): boolean {
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.length < 33) return false
  if (!bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)) return false
  let imageData = false
  for (let offset = 33; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset)
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    offset += 12 + size
    if (offset > bytes.length) return false
    if (type === 'IDAT' && size > 0) imageData = true
    if (type === 'IEND') return imageData && size === 0 && offset === bytes.length
  }
  return false
}

function hasJpegImageData(bytes: Buffer): boolean {
  if (bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) return false
  let frame = false
  let offset = 2
  while (offset + 4 < bytes.length && bytes[offset] === 0xff) {
    while (bytes[offset] === 0xff) offset++
    if (offset + 2 >= bytes.length) return false
    const marker = bytes[offset++]!
    const size = bytes.readUInt16BE(offset)
    if (size < 2 || offset + size > bytes.length - 2) return false
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      frame = size >= 11 && bytes.readUInt16BE(offset + 3) > 0 && bytes.readUInt16BE(offset + 5) > 0
    if (marker === 0xda) return frame && size >= 8 && offset + size < bytes.length - 2
    offset += size
  }
  return false
}

function hasWebpImageData(bytes: Buffer): boolean {
  if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) !== bytes.length - 8) return false
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const start = offset + 8
    const size = bytes.readUInt32LE(offset + 4)
    const end = start + size
    if (end + (size % 2) > bytes.length) return false
    const type = bytes.toString('ascii', offset, offset + 4)
    if (type === 'VP8 ' && size > 10 && bytes.subarray(start + 3, start + 6).toString('hex') === '9d012a') return true
    if (type === 'VP8L' && size > 5 && bytes[start] === 0x2f) return true
    offset = end + (size % 2)
  }
  return false
}

function hasImageEncoding(text: string): boolean {
  if (!/^(?:iVBORw0KGgo|\/9j\/|UklGR)/u.test(text)) return false
  const bytes = Buffer.from(text, 'base64')
  if (bytes.length < 20 || bytes.toString('base64') !== text) return false
  if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') return hasPngImageData(bytes)
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return hasJpegImageData(bytes)
  return hasWebpImageData(bytes)
}

function reflectsHeaders(response: object, secrets: readonly string[]): boolean {
  if (!secrets.length) return false
  const matches = (text: string) => {
    const decoded = decodePercentEscapes(text)
    return secrets.some(secret => text.includes(secret) || decoded.includes(secret))
  }
  const data = 'data' in response && Array.isArray(response.data) ? response.data : []
  const imageItems = new Set<unknown>(data)
  const visit = (value: unknown): boolean => {
    if (typeof value === 'string') return matches(value)
    if (Array.isArray(value)) return value.some(visit)
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, item]) => {
      const imageItem = imageItems.has(value)
      const structuralKey =
        (value === response && ((key === 'data' && Array.isArray(item)) || (key === 'created' && typeof item === 'number'))) ||
        (imageItem && (key === 'b64_json' || key === 'url' || key === 'revised_prompt'))
      if (!structuralKey && matches(key)) return true
      // Only the standard image field can carry opaque Base64. Text disguised as an image still gets checked.
      if (imageItem && key === 'b64_json' && typeof item === 'string' && hasImageEncoding(item))
        return secrets.some(secret => secret === item || (secret.length >= 8 && item.includes(secret)))
      return visit(item)
    })
  }
  return visit(response)
}

async function resultBody(response: Response, { credential, headers }: Pick<PluginUpstream, 'credential' | 'headers'>): Promise<object> {
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
    const decoded = decodePercentEscapes(serialized)
    const literal = JSON.stringify(credential).slice(1, -1)
    if (serialized.includes(literal) || decoded.includes(literal) || decoded.includes(credential)) throw invalid()
    const secrets = headers.map(({ value }) => value.replaceAll('{credential}', () => credential).trim()).filter(Boolean)
    if (reflectsHeaders(value, secrets)) throw invalid()
    return value
  } catch {
    throw invalid()
  }
}
