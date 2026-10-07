import type { CommunityMaintenancePort } from '../ports/community-maintenance.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProxyServer } from 'http-proxy-3'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import type { EntrySessionGate } from './platform-session.js'
import { matchHttpRoute } from './http-routes.js'
import { clearedPlatformCookie, stripPlatformCookie } from './platform-session.js'
import { acceptsPublicHost } from './public-server.js'
import { handleHealth } from './health-route.js'
import { sendCommunityJson } from './community-errors.js'

/** Public HTTP dispatch. The composition root supplies capabilities, not route decisions. */
export function createHttpEntry(deps: {
  readonly maintenance?: CommunityMaintenancePort
  readonly origin: () => URL
  readonly recordsReady: () => boolean
  readonly connections: SessionRegistryPort
  readonly model: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly processGateways: boolean
  readonly bootstrap: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly enter: (request: IncomingMessage, response: ServerResponse, username: string, origin: URL) => Promise<void>
  readonly recovery: (request: IncomingMessage, response: ServerResponse, username: string, origin: URL) => Promise<void>
  readonly loginForm: (response: ServerResponse) => void
  readonly admin: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>
  readonly login: (request: IncomingMessage, response: ServerResponse, origin: URL) => Promise<void>
  readonly session: EntrySessionGate
  readonly ensureRuntime: (userId: string, origin: URL) => Promise<CommunityUserInstance>
  readonly rememberRuntimeCookie: (userId: string, header: string | undefined) => void
  readonly runtimeMount?: (userId: string) => string
  readonly proxy: Pick<ProxyServer, 'web'>
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const origin = deps.origin()
    if (!acceptsPublicHost(request, response, origin)) return
    const url = new URL(request.url ?? '/', origin)
    const route = matchHttpRoute(request.method, url.pathname)
    if (deps.maintenance?.closed() === true && route.id !== 'health' && route.id !== 'ready') {
      sendText(response, 503, 'System upgrade in progress'); return
    }
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
      if (route.id === 'identity') sendCommunityJson(response, 401, { error: 'Sign in is required' })
      else redirectToLogin(response)
      return
    }
    switch (route.id) {
      case 'model': await deps.model(request, response); return
      case 'not-found': sendText(response, 404, 'Not Found'); return
      case 'bootstrap': await deps.bootstrap(request, response); return
      case 'admin': await deps.admin(request, response, url); return
      case 'login-form': deps.loginForm(response); return
      case 'login': await deps.login(request, response, origin); return
      case 'ready': sendText(response, deps.recordsReady() ? 200 : 503, deps.recordsReady() ? 'ready' : 'Starting'); return
      case 'health': handleHealth(response); return
    }
    if (userId === undefined) throw new Error('platform route was not authenticated')
    if (route.id === 'enter') { await deps.enter(request, response, userId, origin); return }
    if (route.id === 'recovery' || route.id === 'identity') { await deps.recovery(request, response, userId, origin); return }
    if (route.id === 'logout') {
      // Stateless logout clears only this login. Accepted tasks and other
      // instance connections keep running.
      response.writeHead(303, { location: '/login', 'cache-control': 'no-store', 'set-cookie': clearedPlatformCookie(origin) })
      response.end()
      return
    }
    const mount = deps.runtimeMount?.(userId)
    if (mount !== undefined) {
      if (url.pathname === '/' || url.pathname === mount.slice(0, -1)) {
        response.writeHead(303, { location: `${mount}${url.search}`, 'cache-control': 'no-store' }); response.end(); return
      }
      if (!url.pathname.startsWith(mount)) { sendText(response, 403, 'Forbidden'); return }
      request.url = `/${url.pathname.slice(mount.length)}${url.search}`
    }
    const instance = await deps.ensureRuntime(userId, origin)
    // Recheck after cold startup: a password change or disable must win.
    if (deps.maintenance?.closed() === true) { sendText(response, 503, 'System upgrade in progress'); return }
    if (!deps.session.current(request, userId)) {
      deps.connections.untrack(request.socket)
      redirectToLogin(response)
      return
    }
    deps.rememberRuntimeCookie(userId, request.headers.cookie)
    deps.connections.track(userId, request.socket)
    stripPlatformCookie(request)
    deps.proxy.web(request, response, { target: instance.origin, ...(mount === undefined ? {} : { cookiePathRewrite: { '*': mount } }) }, () => {
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
