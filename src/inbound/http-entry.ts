import { sendCommunityMaintenance } from './community-maintenance-response.js'
import { communityStartupPage } from './community-startup-page.js'
import { requestLanguage } from './platform-language.js'
import { mergeLaunchCookies } from '../dsh/launch-token.js'
import { mountedDshCookie, secureDshCookie } from './platform-session.js'
import { CommunityRuntimeUnavailableError } from '../ports/community-runtime.js'
import type { CommunityEntry } from '../use-cases/community-entry.js'
import { monitorRuntimeProxy } from './proxy-error.js'
import type { CommunityMaintenancePort } from '../ports/community-maintenance.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProxyServer } from 'http-proxy-3'
import type { CommunityUserInstance } from '../ports/community-runtime.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import type { EntrySessionGate } from './platform-session.js'
import { matchHttpRoute } from './http-routes.js'
import { webToolsOperationForPath } from '../dsh/web-tools.js'
import type { WebToolsOperation } from '../ports/community-web-tools.js'
import { clearedPlatformCookie, stripPlatformCookie } from './platform-session.js'
import { acceptsPublicHost } from './public-server.js'
import { handleHealth } from './health-route.js'
import { sendCommunityJson } from './community-errors.js'

/** Public HTTP dispatch. The composition root supplies capabilities, not route decisions. */
export function createHttpEntry(deps: {
  readonly usageReports?: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly contributions?: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly mcp?: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly execution?: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly market?: (request: IncomingMessage, response: ServerResponse, username: string, origin: URL) => Promise<void>
  readonly maintenance?: CommunityMaintenancePort
  readonly origin: () => URL
  readonly recordsReady: () => boolean
  readonly connections: SessionRegistryPort
  readonly pluginUpstreams?: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly model: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly webTools?: (request: IncomingMessage, response: ServerResponse, operation: WebToolsOperation) => Promise<void>
  readonly onLogout?: (request: IncomingMessage) => void
  readonly processGateways: boolean
  readonly bootstrap: (request: IncomingMessage, response: ServerResponse) => Promise<void>
  readonly enter: (request: IncomingMessage, response: ServerResponse, username: string, origin: URL) => Promise<void>
  readonly recovery: (request: IncomingMessage, response: ServerResponse, username: string, origin: URL) => Promise<void>
  readonly loginForm: (request: IncomingMessage, response: ServerResponse) => void
  readonly admin: (request: IncomingMessage, response: ServerResponse, url: URL) => Promise<void>
  readonly login: (request: IncomingMessage, response: ServerResponse, origin: URL) => Promise<void>
  readonly session: EntrySessionGate
  readonly checkRuntime?: (instance: CommunityUserInstance) => Promise<void>
  readonly runtimeStatus: CommunityEntry['status']
  readonly currentRuntime: CommunityEntry['currentInstance']
  readonly startRuntime: CommunityEntry['start']
  readonly navigateRuntime: CommunityEntry['navigate']
  readonly rememberRuntimeCookie: (userId: string, header: string | undefined) => void
  readonly runtimeMount?: (userId: string) => Promise<string>
  readonly proxy: Pick<ProxyServer, 'web'>
}): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const origin = deps.origin()
    if (!acceptsPublicHost(request, response, origin)) return
    const url = new URL(request.url ?? '/', origin)
    const route = matchHttpRoute(request.method, url.pathname)
    if (deps.maintenance?.closed() === true && route.id !== 'health' && route.id !== 'ready') {
      sendCommunityMaintenance(request, response)
      return
    }
    if (route.id !== 'runtime') deps.connections.untrack(request.socket)
    if (
      (route.id === 'usage-report' ||
        route.id === 'contributions' ||
        route.id === 'mcp' ||
        route.id === 'execution' ||
        route.id === 'model' ||
        route.id === 'web-tools' ||
        route.id === 'plugin-upstream') &&
      !deps.processGateways
    ) {
      sendText(response, 404, 'Not Found')
      return
    }
    if (!deps.recordsReady() && route.needsRuntimeRecords) {
      deps.connections.untrack(request.socket)
      sendText(response, 503, 'Service Unavailable')
      return
    }
    const userId = route.identity === 'platform-user' ? await deps.session.authenticate(request) : undefined
    if (route.identity === 'platform-user' && userId === undefined) {
      deps.connections.untrack(request.socket)
      if (route.id === 'identity' || route.id === 'startup' || (route.id === 'market' && url.pathname.startsWith('/market/api/')))
        sendCommunityJson(response, 401, { error: 'Sign in is required', code: 'sign-in-required' })
      else redirectToLogin(response)
      return
    }
    switch (route.id) {
      case 'usage-report':
        if (deps.usageReports) await deps.usageReports(request, response)
        else sendText(response, 404, 'Not Found')
        return
      case 'contributions':
        if (deps.contributions) await deps.contributions(request, response)
        else sendText(response, 404, 'Not Found')
        return
      case 'mcp':
        if (deps.mcp) await deps.mcp(request, response)
        else sendText(response, 404, 'Not Found')
        return
      case 'execution':
        if (deps.execution) await deps.execution(request, response)
        else sendText(response, 404, 'Not Found')
        return
      case 'plugin-upstream':
        if (deps.pluginUpstreams) await deps.pluginUpstreams(request, response)
        else sendText(response, 404, 'Not Found')
        return
      case 'model':
        await deps.model(request, response)
        return
      case 'web-tools': {
        const operation = webToolsOperationForPath(url.pathname)
        if (deps.webTools && operation !== undefined) await deps.webTools(request, response, operation)
        else sendText(response, 404, 'Not Found')
        return
      }
      case 'not-found':
        sendText(response, 404, 'Not Found')
        return
      case 'bootstrap':
        await deps.bootstrap(request, response)
        return
      case 'admin':
        await deps.admin(request, response, url)
        return
      case 'login-form':
        deps.loginForm(request, response)
        return
      case 'login':
        await deps.login(request, response, origin)
        return
      case 'ready':
        sendText(response, deps.recordsReady() ? 200 : 503, deps.recordsReady() ? 'ready' : 'Starting')
        return
      case 'health':
        handleHealth(response)
        return
    }
    if (userId === undefined) throw new Error('platform route was not authenticated')
    if (route.id === 'market') {
      if (deps.market) await deps.market(request, response, userId, origin)
      else sendText(response, 404, 'Not Found')
      return
    }
    if (route.id === 'enter') {
      await deps.enter(request, response, userId, origin)
      return
    }
    if (route.id === 'recovery' || route.id === 'identity' || route.id === 'startup') {
      await deps.recovery(request, response, userId, origin)
      return
    }
    if (route.id === 'logout') {
      deps.onLogout?.(request)
      // Stateless logout clears only this login. Accepted tasks and other
      // instance connections keep running.
      response.writeHead(303, { location: '/login', 'cache-control': 'no-store', 'set-cookie': clearedPlatformCookie(origin) })
      response.end()
      return
    }
    const mount = await deps.runtimeMount?.(userId)
    if (mount !== undefined) {
      if (url.pathname === '/' || url.pathname === mount.slice(0, -1)) {
        response.writeHead(303, { location: `${mount}${url.search}`, 'cache-control': 'no-store' })
        response.end()
        return
      }
      if (!url.pathname.startsWith(mount)) {
        sendText(response, 403, 'Forbidden')
        return
      }
      request.url = `/${url.pathname.slice(mount.length)}${url.search}`
    }
    const navigation = request.headers['sec-fetch-mode'] === 'navigate' || (request.method === 'GET' && request.headers.accept?.includes('text/html') === true)
    const overlay = () => {
      const { locale } = requestLanguage(request)
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' })
      response.end(communityStartupPage(locale, request.method === 'GET'))
    }
    let status
    try {
      status = await deps.runtimeStatus(userId)
    } catch (error) {
      if (!navigation || !(error instanceof CommunityRuntimeUnavailableError)) throw error
      overlay()
      void deps.startRuntime(userId, origin).catch(() => {})
      return
    }
    if (status.state !== 'ready') {
      if (!navigation) {
        sendText(response, 503, 'Service Unavailable')
        return
      }
      overlay()
      void deps.startRuntime(userId, origin).catch(() => {})
      return
    }
    let instance = status.instance
    let launchCookies: readonly string[] = []
    if (navigation) {
      try {
        const admitted = await deps.navigateRuntime(userId, origin, request.headers.cookie)
        instance = admitted.instance
        launchCookies = admitted.cookies
      } catch (error) {
        if (!(await deps.session.current(request, userId))) {
          redirectToLogin(response)
          return
        }
        if (!(error instanceof CommunityRuntimeUnavailableError)) throw error
        overlay()
        return
      }
    }
    // Recheck after cold startup: a password change or disable must win.
    if (deps.maintenance?.closed() === true) {
      sendText(response, 503, 'System upgrade in progress')
      return
    }
    let runtimeUnavailable = false
    const registered = await deps.session.admit(request, userId, onAbort => {
      if (response.destroyed || request.aborted) return false
      if (deps.maintenance?.closed() === true || !deps.currentRuntime(userId, instance)) {
        runtimeUnavailable = true
        return false
      }
      onAbort(() => {
        deps.connections.untrack(request.socket)
        response.destroy()
        request.socket.destroy()
      })
      deps.connections.track(userId, request.socket)
      return true
    })
    if (!registered) {
      deps.connections.untrack(request.socket)
      if (response.destroyed || request.aborted) return
      if (runtimeUnavailable) sendText(response, 503, 'Service Unavailable')
      else redirectToLogin(response)
      return
    }
    if (response.destroyed || request.aborted) {
      deps.connections.untrack(request.socket)
      return
    }
    if (launchCookies.length) {
      request.headers.cookie = mergeLaunchCookies(request.headers.cookie, launchCookies)
      response.setHeader(
        'set-cookie',
        launchCookies.map(cookie => secureDshCookie(mountedDshCookie(cookie, mount ?? '/'), origin)),
      )
    }
    deps.rememberRuntimeCookie(userId, request.headers.cookie)
    stripPlatformCookie(request)
    const failed = monitorRuntimeProxy(request, instance, deps.checkRuntime)
    deps.proxy.web(request, response, { target: instance.origin, ...(mount === undefined ? {} : { cookiePathRewrite: { '*': mount } }) }, error => {
      failed(error)
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
