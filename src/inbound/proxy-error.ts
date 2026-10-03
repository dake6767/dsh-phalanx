import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

/** Give failed upstream HTTP requests a gateway response; close failed upgrades. */
export function handleProxyError(_error: Error, _request: IncomingMessage, response: ServerResponse | Socket): void {
  if ('writeHead' in response && !response.headersSent) {
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('Bad Gateway')
  } else if ('destroy' in response) {
    response.destroy()
  }
}
