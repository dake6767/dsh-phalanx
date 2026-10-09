import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { CommunityNetworkAccess } from '../use-cases/community-network-access.js'
import type { NetworkTransport } from '../ports/network-transport.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import { sendText } from './http-response.js'

export function communityProxyToken(header: string | string[] | undefined): string | undefined {
  if (typeof header !== 'string' || !/^Basic [A-Za-z0-9+/]+=*$/u.test(header)) return undefined
  const identity = Buffer.from(header.slice(6), 'base64').toString('utf8')
  const separator = identity.indexOf(':')
  return separator < 1 ? undefined : identity.slice(separator + 1)
}
function headers(input: IncomingMessage['headers']) {
  const blocked = new Set(['connection', 'proxy-connection', 'proxy-authorization', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer'])
  for (const value of String(input.connection ?? '').split(',')) blocked.add(value.trim().toLowerCase())
  return Object.fromEntries(Object.entries(input).filter(([name]) => !blocked.has(name.toLowerCase())))
}
/** Standard proxy seam, scoped to current accounts and public pinned destinations. */
export function createCommunityNetworkProxy(deps: {
  readonly access: CommunityNetworkAccess, readonly transport: NetworkTransport, readonly connections: SessionRegistryPort
}) {
  const http = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    let url: URL
    try { url = new URL(request.url ?? '') } catch { sendText(response, 400, 'Bad Request'); return }
    if (url.protocol !== 'http:' || url.username !== '' || url.password !== '') { sendText(response, 400, 'Bad Request'); return }
    const result = await deps.access.authorize({ hostname: url.hostname.replace(/^\[|\]$/gu, ''), port: Number(url.port || '80') }, communityProxyToken(request.headers['proxy-authorization']))
    if (result.status !== 200) {
      if (result.status === 407) response.setHeader('proxy-authenticate', 'Basic realm="Community public network"')
      sendText(response, result.status, 'Public network access denied'); return
    }
    if (response.destroyed || !deps.access.current(result.grant)) { sendText(response, 403, 'Public network access denied'); return }
    const outgoing = deps.transport.http(result.grant, { method: request.method ?? 'GET', path: url.pathname + url.search, headers: { ...headers(request.headers), host: url.host } })
    deps.connections.track(result.grant.username, request.socket)
    const finish = () => { deps.connections.untrack(request.socket); outgoing.request.destroy() }
    response.once('close', finish); request.once('aborted', finish)
    request.pipe(outgoing.request)
    try {
      const incoming = await outgoing.response
      if (!deps.access.current(result.grant)) { incoming.destroy(); response.destroy(); return }
      incoming.on('error', () => response.destroy())
      response.writeHead(incoming.statusCode ?? 502, headers(incoming.headers)); incoming.pipe(response)
    } catch { if (!response.headersSent) sendText(response, 502, 'Public upstream unavailable'); else response.destroy(); finish() }
  }
  const connect = async (request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> => {
    const authority = /^(\[[^\]]+\]|[^:/?#@\s]+):([0-9]+)$/u.exec(request.url ?? '')
    if (authority === null) { client.destroy(); return }
    let url: URL
    try { url = new URL(`http://${request.url ?? ''}`) } catch { client.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    if (url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') { client.destroy(); return }
    const result = await deps.access.authorize({ hostname: url.hostname.replace(/^\[|\]$/gu, ''), port: Number(authority[2]) }, communityProxyToken(request.headers['proxy-authorization']))
    if (result.status !== 200) { client.end(`HTTP/1.1 ${result.status} Access denied\r\nConnection: close\r\n${result.status === 407 ? 'Proxy-Authenticate: Basic realm="Community public network"\r\n' : ''}Content-Length: 0\r\n\r\n`); return }
    if (client.destroyed || !deps.access.current(result.grant)) { client.destroy(); return }
    let remote: Duplex
    try { remote = await deps.transport.connect(result.grant) } catch { client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return }
    if (client.destroyed || !deps.access.current(result.grant)) { remote.destroy(); client.destroy(); return }
    deps.connections.track(result.grant.username, client)
    const finish = () => { deps.connections.untrack(client); remote.destroy(); client.destroy() }
    client.once('close', finish); remote.once('close', () => { if (!remote.readableEnded) finish() })
    client.on('error', finish); remote.on('error', finish)
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head.length > 0) remote.write(head)
    client.pipe(remote); remote.pipe(client)
  }
  return { http, connect }
}
