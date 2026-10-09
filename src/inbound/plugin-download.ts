import type { SessionRegistryPort } from '../ports/session-registry.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { CommunityModelAccessError } from '../domain/community-model.js'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { PluginMarket } from '../use-cases/plugin-market.js'
import type { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import type { PluginArchiveReadPort } from '../ports/plugin-market.js'
import { communityProxyToken } from './community-network-proxy.js'
import { handleCommunityFailure } from './community-errors.js'
import { sendText } from './http-response.js'

/** Exact private proxy destination; never resolves DNS or opens another destination. */
export function createPluginDownload(deps: { connections: Pick<SessionRegistryPort, 'track' | 'untrack'>, market: PluginMarket, authorization: Pick<CommunityModelAuthorization, 'authorize'>, archives: PluginArchiveReadPort }) {
  const http = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    let url: URL
    try { url = new URL(request.url ?? '') } catch { return false }
    if (url.hostname !== 'plugins.dsh-phalanx.invalid') return false
    if (url.protocol !== 'http:' || url.port || url.username || url.password || url.search || url.hash) { sendText(response, 403, 'Forbidden'); return true }
    if (request.method !== 'GET' && request.method !== 'HEAD') { sendText(response, 405, 'Method Not Allowed'); return true }
    const match = /^\/plugin-archive\/([A-Za-z0-9_.-]+)\.tgz$/u.exec(url.pathname)
    if (!match) { sendText(response, 404, 'Not Found'); return true }
    try {
      const username = deps.authorization.authorize(communityProxyToken(request.headers['proxy-authorization']))
      deps.connections.track(username, request.socket)
      const plugin = deps.market.download(match[1]!, username)
      const archive = await deps.archives.open(plugin.artifact)
      deps.authorization.authorize(communityProxyToken(request.headers['proxy-authorization']))
      deps.market.download(match[1]!, username)
      response.writeHead(200, { 'content-type': 'application/gzip', 'content-length': archive.size, 'cache-control': 'no-store' })
      const body = Readable.from(archive.body)
      if (request.method === 'HEAD') { body.destroy(); response.end() }
      else await pipeline(body, response)
    } catch (error) { if (response.headersSent) response.destroy(); else if (error instanceof CommunityModelAccessError) sendText(response, 403, 'Forbidden'); else handleCommunityFailure(response, error, true) }
    finally { deps.connections.untrack(request.socket) }
    return true
  }
  // pnpm uses CONNECT even for an HTTP tarball. Terminate this one synthetic
  // destination locally; the tunnel is permanently bound to its authenticated member.
  const connect = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> => {
    if (request.url?.toLowerCase() !== 'plugins.dsh-phalanx.invalid:80') return false
    const credential = request.headers['proxy-authorization']
    try {
      const username = deps.authorization.authorize(communityProxyToken(credential))
      deps.connections.track(username, socket)
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return true }
    const server = createServer((inner, response) => {
      response.setHeader('connection', 'close')
      if (!inner.url?.startsWith('/') || inner.url.startsWith('//')) { sendText(response, 403, 'Forbidden'); return }
      inner.url = 'http://plugins.dsh-phalanx.invalid' + inner.url
      inner.headers['proxy-authorization'] = credential
      void http(inner, response).catch(() => { response.destroy() })
    })
    server.maxRequestsPerSocket = 1
    server.setTimeout(10000, connection => connection.destroy())
    socket.once('close', () => deps.connections.untrack(socket))
    socket.on('error', () => socket.destroy())
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length) socket.unshift(head)
    server.emit('connection', socket)
    socket.resume()
    return true
  }
  return { http, connect }

}
