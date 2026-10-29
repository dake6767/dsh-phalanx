import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import type { ServicePreview } from '../use-cases/service-preview.js'
import { ServicePreviewError, type PreviewIdentity, type PreviewTarget, type ServicePreviewTransportPort } from '../ports/service-preview.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import { sendText } from './http-response.js'

export function previewPath(raw: string, prefix = '/preview/'): { spaceId: string; port: number; path: string; capability: string | undefined } {
  const match = /^([a-f0-9]{32})\/([1-9][0-9]{3,4})\/(.*)$/u.exec(raw.slice(prefix.length))
  const path = match?.[3]?.split('?')[0]
  if (
    !raw.startsWith(prefix) ||
    !match ||
    path === undefined ||
    /%(?:2f|5c|2e|25)|\\|(?:^|\/)\.\.(?:\/|$)|https?:/iu.test(path) ||
    [...path].some(character => character.charCodeAt(0) < 33)
  ) {
    throw new ServicePreviewError(403, 'Invalid preview address. Use your space, service port and application path.')
  }
  const capability = prefix === '/preview/' ? match[3]!.split('/')[0] : undefined
  if (prefix === '/preview/' && !/^[a-f0-9]{64}$/u.test(capability ?? '')) throw new ServicePreviewError(403, 'Preview access is required.')
  return { spaceId: match[1]!, port: Number(match[2]), path: raw, capability }
}

export function createServicePreviewGateway(deps: {
  access: ServicePreview
  transport: ServicePreviewTransportPort
  identity: (request: IncomingMessage) => Promise<PreviewIdentity | undefined>
  platformOrigin: () => URL
  previewOrigin: () => URL
  available: () => boolean
  connections: SessionRegistryPort
}) {
  const authorize = async (request: IncomingMessage): Promise<PreviewTarget> => {
    if (!deps.available()) throw new ServicePreviewError(503, 'Preview is unavailable during platform maintenance.')
    const origin = deps.previewOrigin()
    if (request.headers.host !== origin.host || (request.headers.origin !== undefined && request.headers.origin !== 'null')) {
      throw new ServicePreviewError(403, 'Forbidden preview origin.')
    }
    const target = previewPath(request.url ?? '')
    if (target.path.split('?')[0]?.endsWith('/__activity')) throw new ServicePreviewError(403, 'Activity is accepted only from the platform preview page.')
    return await deps.access.resolve(target.capability!, target.spaceId, target.port, await deps.identity(request))
  }
  const forwarded = (request: IncomingMessage, target: PreviewTarget) => {
    const headers: IncomingHttpHeaders = { ...request.headers, host: `127.0.0.1:${target.port}` }
    for (const key of Object.keys(headers)) if (/cookie|authorization|^proxy-|^x-forwarded|^forwarded$|^referer$/iu.test(key)) delete headers[key]
    return headers
  }
  const fail = (response: ServerResponse, error: unknown) => {
    if (response.headersSent) {
      response.destroy()
      return
    }
    response.setHeader('access-control-allow-origin', 'null')
    sendText(
      response,
      error instanceof ServicePreviewError ? error.status : 503,
      error instanceof ServicePreviewError
        ? error.message
        : 'Service unavailable. Start or restart the service in your workspace, check its preview prefix, then reload.',
    )
  }
  const http = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const target = await authorize(request)
      if (request.method === 'OPTIONS') {
        if (request.headers.origin !== 'null') throw new ServicePreviewError(403, 'Forbidden preview origin.')
        const headers = request.headers['access-control-request-headers'] ?? ''
        if (!/^[a-z0-9, -]{0,512}$/iu.test(headers)) throw new ServicePreviewError(403, 'Invalid preview headers.')
        response.writeHead(204, {
          'access-control-allow-origin': 'null',
          'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
          'access-control-allow-headers': headers,
          'cache-control': 'no-store',
        })
        response.end()
        return
      }
      let release: (() => void) | undefined
      const upstream = httpRequest(
        {
          host: '127.0.0.1',
          port: target.port,
          path: request.url,
          method: request.method,
          headers: forwarded(request, target),
          createConnection: () => deps.transport.connect(target),
        },
        peer => {
          peer.once('error', () => response.destroy())
          peer.once('aborted', () => response.destroy())
          void (async () => {
            clearTimeout(timeout)
            if (!(await deps.access.current(target))) {
              peer.destroy()
              fail(response, new ServicePreviewError(403, 'Preview access changed.'))
              return
            }
            if (response.destroyed || response.writableEnded) {
              peer.destroy()
              return
            }
            const headers = { ...peer.headers }
            for (const key of Object.keys(headers))
              if (/^set-cookie|^access-control-|^clear-site-data$|^service-worker-allowed$/iu.test(key)) delete headers[key]
            if (headers.location) {
              peer.destroy()
              fail(response, new ServicePreviewError(503, 'Redirects are unsupported. Configure your application to use its full preview prefix.'))
              return
            }
            const source = deps.previewOrigin().origin,
              websocket = source.replace(/^http/u, 'ws')
            headers['content-security-policy'] =
              `sandbox allow-scripts allow-forms; default-src ${source}; script-src ${source} 'unsafe-inline' 'unsafe-eval'; style-src ${source} 'unsafe-inline'; connect-src ${source} ${websocket}; img-src ${source} data: blob:; frame-src 'none'; object-src 'none'; base-uri ${source}; form-action ${source}; worker-src 'none'; frame-ancestors ${deps.platformOrigin().origin}`
            headers['access-control-allow-origin'] = 'null'
            headers['x-content-type-options'] = 'nosniff'
            headers['cache-control'] = 'no-store'
            headers['referrer-policy'] = 'no-referrer'
            response.writeHead(peer.statusCode ?? 502, headers)
            peer.once('aborted', () => response.destroy())
            peer.once('error', () => response.destroy())
            peer.pipe(response)
            response.once('close', () => peer.destroy())
          })().catch(error => {
            peer.destroy()
            fail(response, error)
          })
        },
      )
      upstream.on('error', error => fail(response, error))
      const timeout = setTimeout(() => upstream.destroy(new Error('Preview handshake timed out')), 15000)
      timeout.unref()
      upstream.once('error', () => clearTimeout(timeout))
      upstream.once('close', () => clearTimeout(timeout))
      response.once('close', () => {
        release?.()
        upstream.destroy()
      })
      request.once('aborted', () => upstream.destroy())
      try {
        release = await deps.access.track(target, () => {
          upstream.destroy()
          response.destroy()
        })
      } catch (error) {
        upstream.destroy()
        throw error
      }
      if (response.destroyed || response.writableEnded || request.aborted) {
        release()
        upstream.destroy()
        return
      }
      request.pipe(upstream)
    } catch (error) {
      fail(response, error)
    }
  }
  const upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => {})
    const reject = (status: number) =>
      !socket.destroyed && !socket.writableEnded && socket.end(`HTTP/1.1 ${status} Preview unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    try {
      const target = await authorize(request)
      const upstream = httpRequest({
        host: '127.0.0.1',
        port: target.port,
        path: request.url,
        headers: forwarded(request, target),
        createConnection: () => deps.transport.connect(target),
      })
      let release: (() => void) | undefined
      socket.once('close', () => {
        release?.()
        upstream.destroy()
      })
      const timeout = setTimeout(() => upstream.destroy(new Error('Preview handshake timed out')), 15000)
      timeout.unref()
      upstream.once('error', () => clearTimeout(timeout))
      upstream.once('close', () => clearTimeout(timeout))
      upstream.once('upgrade', async (response, peer, remoteHead) => {
        response.on('error', () => peer.destroy())
        peer.once('error', () => socket.destroy())
        peer.once('close', () => socket.destroy())
        socket.once('close', () => peer.destroy())
        clearTimeout(timeout)
        try {
          await authorize(request)
          // Final synchronous account/container/session check precedes the 101 and registration.
          const untrack = await deps.access.track(target, () => {
            peer.destroy()
            socket.destroy()
          })
          release?.()
          if (socket.destroyed || socket.writableEnded || peer.destroyed) {
            untrack()
            peer.destroy()
            return
          }
          const headers = ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions'].flatMap(key =>
            response.headers[key] === undefined ? [] : [`${key}: ${String(response.headers[key])}`],
          )
          socket.write('HTTP/1.1 101 Switching Protocols\r\n' + headers.join('\r\n') + '\r\n\r\n')
          if (remoteHead.length) socket.write(remoteHead)
          if (head.length) peer.write(head)
          socket.pipe(peer).pipe(socket)
          peer.once('error', () => socket.destroy())
          socket.once('error', () => peer.destroy())
          socket.once('close', () => {
            untrack()
            peer.destroy()
          })
          peer.once('close', () => socket.destroy())
        } catch {
          peer.destroy()
          reject(403)
        }
      })
      upstream.once('response', peer => {
        peer.destroy()
        reject(503)
      })
      upstream.on('error', () => reject(503))
      try {
        release = await deps.access.track(target, () => {
          upstream.destroy()
          socket.destroy()
        })
      } catch (error) {
        upstream.destroy()
        throw error
      }
      if (socket.destroyed || socket.writableEnded) {
        release()
        upstream.destroy()
        return
      }
      upstream.end()
    } catch (error) {
      reject(error instanceof ServicePreviewError ? error.status : 503)
    }
  }
  return () => {
    const server = createServer(http)
    server.on('upgrade', upgrade)
    server.on('connection', socket => deps.connections.registerConnection(socket, false))
    return server
  }
}
