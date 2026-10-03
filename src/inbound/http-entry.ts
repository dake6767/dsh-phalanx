import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProxyServer } from 'http-proxy-3'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import type { EntrySessionGate } from './platform-session.js'
import { matchHttpRoute } from './http-routes.js'
import { clearedPlatformCookie, stripPlatformCookie } from './platform-session.js'
import { acceptsPublicHost } from './public-server.js'
import { handleHealth } from './health-route.js'

/** Public HTTP dispatch. The composition root supplies capabilities, not route decisions. */
export function createHttpEntry(deps: {
  readonly origin: () => URL
  readonly recordsReady: () => boolean
  readonly connections: SessionRegistryPort
  readonly model: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly processGateways: boolean
  readonly bootstrap: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly loginForm: (response: ServerResponse) => void
  readonly admin: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>
  readonly login: (request: IncomingMessage, response: ServerResponse, origin: URL) => Promise<void>
  readonly session: EntrySessionGate
  readonly ensureRuntime: (userId: string, origin: URL) => Promise<CommunityUserInstance>
  readonly rememberRuntimeCookie: (userId: string, header: string | undefined) => void
  readonly proxy: Pick<ProxyServer, 'web'>
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const origin = deps.origin()
    if (!acceptsPublicHost(request, response, origin)) return
    const url = new URL(request.url ?? '/', origin)
    const route = matchHttpRoute(request.method, url.pathname)
    if (route.id !== 'runtime') deps.connections.untrack(request.socket)
    if (route.id === 'model' && !deps.processGateways) {
      sendText(response, 404, 'Not Found'); return
    }
    if (!deps.recordsReady() && route.needsRuntimeRecords) {
      deps.connections.untrack(request.socket)
      sendText(response, 503, 'Service Unavailable')
      return
    }
    const userId = route.identity === 'platform-user' ? deps.session.authenticate(request) : undefined
    if (route.identity === 'platform-user' && userId === undefined) {
      deps.connections.untrack(request.socket)
      redirectToLogin(response)
      return
    }
    switch (route.id) {
      case 'model': await deps.model(request, response); return
      case 'not-found': sendText(response, 404, 'Not Found'); return
      case 'bootstrap': await deps.bootstrap(request, response); return
      case 'admin': await deps.admin(request, response, url); return
      case 'login-form': deps.loginForm(response); return
      case 'login': await deps.login(request, response, origin); return
      case 'health': handleHealth(response); return
    }
    if (userId === undefined) throw new Error('platform route was not authenticated')
    if (route.id === 'logout') {
      // Stateless logout clears only this login. Accepted tasks and other
      // instance connections keep running.
      response.writeHead(303, { location: '/login', 'cache-control': 'no-store', 'set-cookie': clearedPlatformCookie(origin) })
      response.end()
      return
    }
    const instance = await deps.ensureRuntime(userId, origin)
    // Recheck after cold startup: a password change or disable must win.
    if (!deps.session.current(request, userId)) {
      deps.connections.untrack(request.socket)
      redirectToLogin(response)
      return
    }
    deps.rememberRuntimeCookie(userId, request.headers.cookie)
    deps.connections.track(userId, request.socket)
    stripPlatformCookie(request)
    deps.proxy.web(request, response, { target: instance.origin }, () => {
      if (!response.headersSent) sendText(response, 502, 'Bad Gateway')
      else response.destroy()
    })
  }
}

function redirectToLogin(response: ServerResponse): void {
  response.writeHead(303, { location: '/login' })
  response.end()
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
  response.end(body)
}
