import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PluginUpstreamTransportError, HOP_HEADERS, PLUGIN_BODY_LIMIT, PLUGIN_TIMEOUT_MS } from '../domain/plugin-upstream.js'
import type { PluginUpstreamTransportPort } from '../ports/plugin-upstreams.js'

/** Direct host HTTP with explicit limits; never follows redirects or buffers bodies. */
export class NodePluginUpstreamTransport implements PluginUpstreamTransportPort {
  async send(input: Parameters<PluginUpstreamTransportPort['send']>[0]): Promise<Response> {
    const base = new URL(input.upstream.baseUrl)
    const headers: Record<string, string | string[]> = {}
    const connection = input.headers.connection
    const blocked = new Set([...HOP_HEADERS, ...(typeof connection === 'string' ? connection.split(',').map(value => value.trim().toLowerCase()) : []),
      'host', 'authorization', 'cookie', 'x-api-key', 'expect', ...input.upstream.headers.map(row => row.name.toLowerCase())])
    for (const [name, value] of Object.entries(input.headers)) if (value !== undefined && !blocked.has(name.toLowerCase()) && !name.toLowerCase().startsWith('proxy-')) headers[name] = typeof value === 'string' ? value : [...value]
    for (const header of input.upstream.headers) headers[header.name.toLowerCase()] = header.value.replaceAll('{credential}', input.upstream.credential)
    // Node otherwise omits framing for unknown-length GET/DELETE/OPTIONS bodies.
    if (headers['content-length'] === undefined) headers['transfer-encoding'] = 'chunked'
    const declared = Number(headers['content-length'])
    if (Number.isFinite(declared) && declared > PLUGIN_BODY_LIMIT) throw new PluginUpstreamTransportError(413, 'Plugin request body exceeds 64 MiB')
    return await new Promise<Response>((resolve, reject) => {
      const outgoing = (base.protocol === 'https:' ? httpsRequest : httpRequest)({ protocol: base.protocol, hostname: base.hostname.replace(/^\[|\]$/gu, ''), port: base.port,
        method: input.method, path: `${base.pathname.replace(/\/$/u, '')}${input.path}`, headers, signal: input.signal })
      const timer = setTimeout(() => outgoing.destroy(new PluginUpstreamTransportError(504, 'Plugin upstream response timed out')), PLUGIN_TIMEOUT_MS)
      timer.unref()
      outgoing.setTimeout(PLUGIN_TIMEOUT_MS, () => outgoing.destroy(new PluginUpstreamTransportError(504, 'Plugin upstream idle timeout')))
      outgoing.once('error', reject)
      outgoing.once('close', () => clearTimeout(timer))
      outgoing.once('response', incoming => {
        clearTimeout(timer)
        const responseHeaders = new Headers()
        const responseBlocked = new Set([...HOP_HEADERS, 'set-cookie', ...(incoming.headers.connection?.split(',').map(value => value.trim().toLowerCase()) ?? [])])
        for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && !responseBlocked.has(name)) {
          for (const entry of Array.isArray(value) ? value : [value]) responseHeaders.append(name, entry)
        }
        const status = incoming.statusCode ?? 502
        const noBody = input.method === 'HEAD' || [204, 205, 304].includes(status)
        if (noBody) incoming.resume()
        resolve(new Response(noBody ? null : Readable.toWeb(incoming) as ReadableStream<Uint8Array>, { status, headers: responseHeaders }))
      })
      let bytes = 0
      const limit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length
        callback(bytes > PLUGIN_BODY_LIMIT ? new PluginUpstreamTransportError(413, 'Plugin request body exceeds 64 MiB') : null, chunk)
      } })
      void pipeline(Readable.fromWeb(input.body as import('node:stream/web').ReadableStream<Uint8Array>), limit, outgoing).catch(error => { outgoing.destroy(); reject(error) })
    })
  }
}
