import type { CommunityUserInstance } from '../ports/community-runtime.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

const failureHandler = Symbol('runtime-proxy-failure')
type RuntimeProxyRequest = IncomingMessage & { [failureHandler]?: (error: Error) => void }

/** Give failed upstream HTTP requests a gateway response; close failed upgrades. */
export function handleProxyError(_error: Error, _request: IncomingMessage, response: ServerResponse | Socket): void {
  if ('writeHead' in response && !response.headersSent) {
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Bad Gateway')
  } else if ('destroy' in response) {
    response.destroy()
  }
}

/** A truncated upstream must fail its browser download, not leave it pending. */
export function closeIncompleteProxyResponse(upstream: IncomingMessage, request: IncomingMessage, response: ServerResponse): void {
  const close = (): void => {
    if (!request.socket.destroyed) (request as RuntimeProxyRequest)[failureHandler]?.(Object.assign(new Error('Upstream response was truncated'), { code: 'ECONNRESET' }))
    response.destroy()
  }
  upstream.once('aborted', close)
  upstream.once('error', close)
}


/** Only carrier connection failures justify a health query; the transfer is never repeated. */
export async function checkFailedRuntime(error: Error, instance: CommunityUserInstance,
  check?: (instance: CommunityUserInstance) => Promise<void>): Promise<void> {
  const code = (error as NodeJS.ErrnoException).code
  if (code !== 'ECONNREFUSED' && code !== 'ECONNRESET') return
  try { await check?.(instance) }
  catch { console.warn('User instance health check failed; retained its registration') }
}


/** One failed transfer can emit multiple error events, but owns at most one health query. */
export function monitorRuntimeProxy(request: IncomingMessage, instance: CommunityUserInstance,
  check?: (instance: CommunityUserInstance) => Promise<void>): (error: Error) => void {
  let reported = false
  const report = (error: Error): void => {
    if (reported) return
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ECONNREFUSED' && code !== 'ECONNRESET') return
    reported = true
    void checkFailedRuntime(error, instance, check)
  }
  ;(request as RuntimeProxyRequest)[failureHandler] = report
  return report
}
