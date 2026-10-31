import type { CommunityStartupFailure } from '../ports/community-supervision.js'
import { sendCommunityMaintenance } from './community-maintenance-response.js'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import type { CommunityMaintenancePort } from '../ports/community-maintenance.js'
import { resolvePlatformLocale } from '../domain/platform-language.js'
import { sendText } from './http-response.js'
import { matchHttpRoute } from './http-routes.js'
import { acceptsPublicHost, listen } from './public-server.js'

export interface PublicEntryBinding {
  origin(): URL
  bind(server: Server, register: (socket: Socket) => void): URL
  unbind(server: Server): void
}

/** One HTTP parser and socket owner for the public port; disposable graphs own admitted business connections. */
export class StablePublicEntry implements PublicEntryBinding {
  private binding: { server: Server; register: (socket: Socket) => void; connections: WeakSet<Socket> } | undefined
  private readonly sockets = new Set<Socket>()
  private unavailability: CommunityStartupFailure | undefined
  private get configurationUnavailable() {
    return this.unavailability !== undefined
  }
  private publicOrigin: URL | undefined
  private readonly server: Server
  private starting: Promise<string> | undefined
  private closing: Promise<void> | undefined
  constructor(
    private readonly config: { readonly host: string; readonly port: number; readonly publicOrigin?: string },
    private readonly maintenance: CommunityMaintenancePort,
  ) {
    this.server = createServer((request, response) => {
      if (!this.publicOrigin || !acceptsPublicHost(request, response, this.publicOrigin)) return
      let path: string
      try {
        path = new URL(request.url ?? '/', this.publicOrigin).pathname
      } catch {
        if (this.binding) sendText(response, 400, 'Bad Request')
        else if (this.maintenance.closed()) sendCommunityMaintenance(request, response)
        else this.diagnostic(request, response)
        return
      }
      const route = matchHttpRoute(request.method, path)
      if (this.maintenance.closed() && route.id !== 'health' && route.id !== 'ready') {
        sendCommunityMaintenance(request, response)
        return
      }
      const binding = this.binding
      if (!binding) {
        this.diagnostic(request, response)
        return
      }
      this.register(binding, request.socket)
      binding.server.emit('request', request, response)
    })
    this.server.on('connection', socket => {
      this.sockets.add(socket)
      socket.once('close', () => {
        this.sockets.delete(socket)
      })
    })
    this.server.on('upgrade', (request, socket, head) => {
      const binding = this.binding
      if (!binding || this.maintenance.closed()) {
        this.refuse(socket)
        return
      }
      this.register(binding, request.socket)
      binding.server.emit('upgrade', request, socket, head)
    })
    this.server.on('connect', (_request, socket) => {
      this.refuse(socket)
    })
  }
  start(): Promise<string> {
    if (this.starting || this.closing) return Promise.reject(Error('Public entry cannot start twice'))
    return (this.starting = this.open())
  }
  private async open(): Promise<string> {
    await listen(this.server, this.config.port, this.config.host)
    if (this.closing) throw Error('Public entry stopped during startup')
    const address = this.server.address()
    if (!address || typeof address === 'string') throw Error('Public entry has no TCP address')
    this.publicOrigin = new URL(this.config.publicOrigin ?? `http://${this.config.host}:${address.port}`)
    return this.publicOrigin.origin
  }
  origin(): URL {
    if (!this.publicOrigin || this.closing) throw Error('Public entry is unavailable')
    return new URL(this.publicOrigin)
  }
  bind(server: Server, register: (socket: Socket) => void): URL {
    if (!this.publicOrigin || this.closing || server.listening || this.binding) throw Error('Public entry cannot bind this graph')
    this.binding = { server, register, connections: new WeakSet() }
    return new URL(this.publicOrigin)
  }
  unbind(server: Server): void {
    if (this.binding?.server === server) this.binding = undefined
  }
  suspend(reason?: CommunityStartupFailure): void {
    this.binding = undefined
    this.unavailability = reason
  }
  stop(): Promise<void> {
    return (this.closing ??= (async () => {
      this.suspend()
      await this.starting?.catch(() => {})
      for (const socket of this.sockets) socket.destroy()
      if (this.server.listening)
        await new Promise<void>((resolve, reject) => {
          this.server.close(error => {
            if (error) reject(error)
            else resolve()
          })
        })
      this.publicOrigin = undefined
    })())
  }
  private register(binding: NonNullable<StablePublicEntry['binding']>, socket: Socket): void {
    if (binding.connections.has(socket)) return
    binding.connections.add(socket)
    binding.register(socket)
  }
  private refuse(socket: Duplex): void {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\nRetry-After: 3\r\n\r\n')
  }
  private diagnostic(request: IncomingMessage, response: ServerResponse): void {
    const chinese = resolvePlatformLocale(request.headers.cookie, request.headers['accept-language']) === 'zh-CN'
    const maintenance = this.maintenance.closed()
    const title = maintenance
      ? chinese
        ? '平台正在维护'
        : 'Platform maintenance in progress'
      : chinese
        ? '平台数据库暂时不可用'
        : 'Platform database is temporarily unavailable'
    const unavailableTitle = this.configurationUnavailable ? (chinese ? '平台配置需要修复' : 'Platform configuration requires recovery') : title
    const detail =
      this.configurationUnavailable && !maintenance
        ? chinese
          ? '请检查平台数据库配置与主密钥是否匹配。由部署者恢复后重启平台。'
          : 'Check that the platform database configuration and master key match. An operator must recover the configuration and restart the platform.'
        : maintenance
          ? chinese
            ? '维护完成后页面将自动恢复。'
            : 'This page will recover automatically after maintenance.'
          : chinese
            ? '请检查数据库服务与连接配置。连接恢复后页面将自动恢复。'
            : 'Check the database service and connection settings. This page will recover automatically when the connection is restored.'
    const permanentReadinessFailure = this.configurationUnavailable && request.method === 'GET' && (request.url ?? '').split('?')[0] === '/readyz'
    const json = permanentReadinessFailure || (request.url ?? '').startsWith('/admin/api/') || (request.headers.accept ?? '').includes('application/json')
    response.writeHead(503, {
      'cache-control': 'no-store',
      'retry-after': '3',
      'content-type': json ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
      'x-content-type-options': 'nosniff',
    })
    response.end(
      json
        ? JSON.stringify({
            code:
              maintenance && !permanentReadinessFailure
                ? 'platform-maintenance'
                : this.configurationUnavailable
                  ? 'platform-configuration-unavailable'
                  : 'platform-database-unavailable',
            ...(this.unavailability === 'migration' ? { errorCode: 'migration.failed' } : {}),
            error: unavailableTitle,
            detail,
          })
        : `<!doctype html><html lang="${chinese ? 'zh-CN' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="3"><title>${unavailableTitle}</title></head><body><main><h1>${unavailableTitle}</h1><p>${detail}</p></main></body></html>`,
    )
  }
}
