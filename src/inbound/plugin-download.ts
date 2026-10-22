import type { SessionRegistryPort } from '../ports/session-registry.js'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { CommunityModelAccessError } from '../domain/community-model.js'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { NativePluginDownloads } from '../use-cases/native-plugin-downloads.js'
import type { CommunityModelAuthorization } from '../use-cases/community-model-authorization.js'
import type { PluginArchiveReadPort } from '../ports/native-plugin-downloads.js'
import { communityProxyToken } from './community-network-proxy.js'
import { handleCommunityFailure } from './community-errors.js'
import { sendText } from './http-response.js'

/** Exact private proxy destination; never resolves DNS or opens another destination. */
export function createPluginDownload(deps: { connections: Pick<SessionRegistryPort, 'track' | 'untrack'>, downloads: NativePluginDownloads, authorization: Pick<CommunityModelAuthorization, 'authorize'>, archives: PluginArchiveReadPort }) {
  const http = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    let url: URL
    try { url = new URL(request.url ?? '') } catch {
      if (!/^https?:\/\/(?:[^/@]*@)?plugins\.dsh-phalanx\.invalid(?=[:/]|$)/iu.test(request.url ?? '')) return false
      sendText(response, 403, 'Forbidden'); return true
    }
    if (url.hostname.replace(/\.$/u, '') !== 'plugins.dsh-phalanx.invalid') return false
    if (url.protocol !== 'http:' || url.port || url.username || url.password || url.search || url.hash) { sendText(response, 403, 'Forbidden'); return true }
    if (request.method !== 'GET' && request.method !== 'HEAD') { sendText(response, 405, 'Method Not Allowed'); return true }
    const match = /^\/plugin-archive\/([A-Za-z0-9_.-]+)\.tgz$/u.exec(url.pathname)
    if (!match) { sendText(response, 404, 'Not Found'); return true }
    try {
      const username = deps.authorization.authorize(communityProxyToken(request.headers['proxy-authorization']))
      deps.connections.track(username, request.socket)
      const plugin = deps.downloads.read(match[1]!, username)
      const archive = await deps.archives.open(plugin.artifact)
      deps.authorization.authorize(communityProxyToken(request.headers['proxy-authorization']))
      deps.downloads.read(match[1]!, username)
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
    let destination: URL
    try { destination = new URL('http://' + (request.url ?? '')) } catch {
      if (!/^plugins\.dsh-phalanx\.invalid(?=[:/]|$)/iu.test(request.url ?? '')) return false
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return true
    }
    if (destination.hostname.replace(/\.$/u, '') !== 'plugins.dsh-phalanx.invalid') return false
    if (request.url?.toLowerCase() !== 'plugins.dsh-phalanx.invalid:80') { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return true }
    const credential = request.headers['proxy-authorization']
    try {
      const username = deps.authorization.authorize(communityProxyToken(credential))
      deps.connections.track(username, socket)
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return true }
    const server = createServer((inner, response) => {
      response.setHeader('connection', 'close')
      if (!inner.url?.startsWith('/') || inner.url.startsWith('//') || !/^plugins\.dsh-phalanx\.invalid(?::80)?$/iu.test(inner.headers.host ?? '')) { sendText(response, 403, 'Forbidden'); return }
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
