import type { Server } from 'node:http'
import type { CommunityApplication } from '../ports/community-application.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { SessionRegistryPort } from '../ports/session-registry.js'
import type { CommunityConfig } from '../domain/community-config.js'
import { listen } from '../inbound/public-server.js'

/** Owns listener readiness and shutdown. Existing user spaces remain durable. */
export class CommunityLifecycle implements CommunityApplication {
  private server: Server | undefined
  private gateway: Server | undefined
  private publicOrigin: URL | undefined
  private ready = false
  private stopped = false
  private idleTimer: NodeJS.Timeout | undefined
  constructor(private readonly deps: {
    config: CommunityConfig, knownUsers: () => ReadonlySet<string>,
    runtime: CommunityRuntimePort, connections: Pick<SessionRegistryPort, 'closeAll'>,
    createListener: () => Server, createGatewayListener?: () => Server, checkIdle: () => Promise<void>, prepareBootstrap: () => void | Promise<void>, closeResources: () => void | Promise<void>,
  }) {}
  origin(): URL {
    if (this.publicOrigin === undefined) throw new Error('Community entry is not listening')
    return this.publicOrigin
  }
  gatewayOrigin(): URL {
    const address = this.gateway?.address()
    if (address === undefined || address === null || typeof address === 'string') throw new Error('Private model gateway is not listening')
    return new URL(`http://127.0.0.1:${address.port}`)
  }
  recordsReady(): boolean { return this.ready }
  async start(): Promise<string> {
    if (this.server !== undefined || this.stopped) throw new Error('Community entry cannot be started twice')
    try {
      await this.deps.prepareBootstrap()
      if (this.stopped) throw new Error('Community entry stopped during bootstrap')
      const server = this.deps.createListener()
      this.server = server
      await listen(server, this.deps.config.listen.port, this.deps.config.listen.host)
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('Community listener has no TCP address')
      this.publicOrigin = new URL(this.deps.config.listen.publicOrigin ?? `http://${this.deps.config.listen.host}:${address.port}`)
      if (this.deps.createGatewayListener !== undefined) {
        this.gateway = this.deps.createGatewayListener()
        await listen(this.gateway, this.deps.config.runtime.container?.gatewayPort ?? 0, '127.0.0.1')
      }
      await this.deps.runtime.reconcileStartupContainers(this.deps.knownUsers(), this.publicOrigin.host)
      this.ready = true
      const idleSeconds = this.deps.config.idleReclaimSeconds
      if (idleSeconds !== undefined && idleSeconds > 0) {
        this.idleTimer = setInterval(() => { void this.deps.checkIdle() }, Math.min(30_000, Math.max(1_000, Math.floor(idleSeconds * 250))))
        this.idleTimer.unref()
      }
      return this.publicOrigin.origin
    } catch (error) { await this.stop(); throw error }
  }
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.ready = false
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    this.deps.connections.closeAll()
    try {
      await Promise.all([this.server, this.gateway].map(async server => {
        if (server?.listening === true) await new Promise<void>((resolve, reject) => {
          server.close(error => { if (error === undefined) resolve(); else reject(error) })
        })
      }))
    } finally {
      try { await this.deps.runtime.stopAll() }
      finally { await this.deps.closeResources(); this.server = undefined; this.gateway = undefined; this.publicOrigin = undefined }
    }
  }
}
