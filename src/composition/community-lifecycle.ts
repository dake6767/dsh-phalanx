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
  private preview: Server | undefined
  private previewTimer: NodeJS.Timeout | undefined
  private publicOrigin: URL | undefined
  private ready = false
  private stopped = false
  private idleTimer: NodeJS.Timeout | undefined
  constructor(private readonly deps: {
    config: CommunityConfig, knownUsers: () => ReadonlySet<string>,
    runtime: CommunityRuntimePort, connections: Pick<SessionRegistryPort, 'closeAll'>,
    createPreviewListener?: () => Server, sweepPreview?: () => void,
    startBackgroundWork?: () => void, createListener: () => Server, createGatewayListener?: () => Server, checkIdle: () => Promise<void>, checkIntervalMs?: number, prepareBootstrap: () => void | Promise<void>, closeResources: () => void | Promise<void>,
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
      if (this.deps.createPreviewListener && this.deps.config.preview) {
        this.preview = this.deps.createPreviewListener()
        await listen(this.preview, this.deps.config.preview.port, this.deps.config.listen.host)
        this.previewTimer = setInterval(() => this.deps.sweepPreview?.(), 250)
        this.previewTimer.unref()
      }
      await this.deps.runtime.reconcileStartupContainers(this.deps.knownUsers(), this.publicOrigin.host)
      this.ready = true
      this.deps.startBackgroundWork?.()
      this.idleTimer = setInterval(() => { void this.deps.checkIdle() }, this.deps.checkIntervalMs ?? 30_000)
      this.idleTimer.unref()
      return this.publicOrigin.origin
    } catch (error) { await this.stop(); throw error }
  }
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.ready = false
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    if (this.previewTimer !== undefined) clearInterval(this.previewTimer)
    this.deps.connections.closeAll()
    try {
      await Promise.all([this.server, this.gateway, this.preview].map(async server => {
        if (server?.listening === true) await new Promise<void>((resolve, reject) => {
          server.close(error => { if (error === undefined) resolve(); else reject(error) })
        })
      }))
    } finally {
      try { await this.deps.runtime.stopAll() }
      finally { await this.deps.closeResources(); this.server = undefined; this.gateway = undefined; this.preview = undefined; this.publicOrigin = undefined }
    }
  }
}
