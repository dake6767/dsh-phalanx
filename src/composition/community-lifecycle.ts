import type { PublicEntryBinding } from '../inbound/stable-public-entry.js'
import type { Socket } from 'node:net'
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
  private activation: Promise<void> | undefined
  private releaseEntry!: () => void
  private readonly entryStarted = new Promise<void>(resolve => {
    this.releaseEntry = resolve
  })
  private ready = false
  private stopped = false
  private stopping: Promise<void> | undefined
  private failed = false
  private failureNotified = false
  private readonly failureListeners = new Set<() => void>()
  private readonly background = new Map<string, Promise<void>>()
  private idleTimer: NodeJS.Timeout | undefined
  constructor(
    private readonly deps: {
      publicEntry?: PublicEntryBinding
      registerPublicConnection?: (socket: Socket) => void
      prepareEntry?: () => Promise<boolean>
      config: CommunityConfig
      knownUsers: () => Promise<ReadonlySet<string>>
      runtime: CommunityRuntimePort
      connections: Pick<SessionRegistryPort, 'closeAll'>
      createPreviewListener?: () => Server
      sweepPreview?: () => Promise<void>
      startBackgroundWork?: () => void | Promise<void>
      createListener: () => Server
      createGatewayListener?: () => Server
      checkIdle: () => Promise<void>
      checkIntervalMs?: number
      prepareBootstrap: () => void | Promise<void>
      closeResources: () => void | Promise<void>
    },
  ) {}
  origin(): URL {
    if (this.publicOrigin === undefined) throw new Error('Community entry is not listening')
    return this.publicOrigin
  }
  gatewayOrigin(): URL {
    const address = this.gateway?.address()
    if (address === undefined || address === null || typeof address === 'string') throw new Error('Private model gateway is not listening')
    return new URL(`http://127.0.0.1:${address.port}`)
  }
  recordsReady(): boolean {
    return this.ready
  }
  async start(): Promise<string> {
    if (this.server !== undefined || this.stopped) throw new Error('Community entry cannot be started twice')
    try {
      const activate = (await this.deps.prepareEntry?.()) ?? true
      if (activate) await this.deps.prepareBootstrap()
      if (this.stopped || this.failed) throw new Error('Community entry stopped during bootstrap')
      const server = this.deps.createListener()
      this.server = server
      if (this.deps.publicEntry) {
        if (!this.deps.registerPublicConnection) throw Error('Public entry requires a connection registry')
        this.publicOrigin = this.deps.publicEntry.origin()
      } else {
        await listen(server, this.deps.config.listen.port, this.deps.config.listen.host)
        const address = server.address()
        if (address === null || typeof address === 'string') throw new Error('Community listener has no TCP address')
        this.publicOrigin = new URL(this.deps.config.listen.publicOrigin ?? `http://${this.deps.config.listen.host}:${address.port}`)
      }
      if (this.deps.createGatewayListener !== undefined) {
        this.gateway = this.deps.createGatewayListener()
        await listen(this.gateway, this.deps.config.runtime.container?.gatewayPort ?? 0, '127.0.0.1')
      }
      if (this.deps.createPreviewListener && this.deps.config.preview) {
        this.preview = this.deps.createPreviewListener()
        await listen(this.preview, this.deps.config.preview.port, this.deps.config.listen.host)
        this.previewTimer = setInterval(
          () =>
            this.runBackground('preview', async () => {
              await this.deps.sweepPreview?.()
            }),
          250,
        )
        this.previewTimer.unref()
      }
      if (!activate) {
        this.bindPublicEntry()
        this.releaseEntry()
        return this.publicOrigin.origin
      }
      await this.finishActivation()
      this.bindPublicEntry()
      this.releaseEntry()
      return this.publicOrigin.origin
    } catch (error) {
      await this.stop()
      throw error
    }
  }
  private bindPublicEntry(): void {
    if (this.deps.publicEntry && this.server && this.deps.registerPublicConnection) this.deps.publicEntry.bind(this.server, this.deps.registerPublicConnection)
  }
  onFailure(listener: () => void): void {
    if (this.failureNotified) listener()
    else this.failureListeners.add(listener)
  }
  /** A failed activation is never retried using partially initialized owner caches. */
  fail(): void {
    if (this.failed || this.stopped) return
    this.failed = true
    this.ready = false
    if (this.server) this.deps.publicEntry?.unbind(this.server)
    const notify = () => {
      this.failureNotified = true
      for (const listener of this.failureListeners) {
        try {
          listener()
        } catch {
          console.warn('Platform failure observer failed')
        }
      }
      this.failureListeners.clear()
    }
    // Let the active request report its failure before closing its transport.
    setImmediate(() => {
      void this.stop().then(notify, notify)
    })
  }
  async activateRecords(): Promise<void> {
    if (this.stopped || !this.server || (!this.deps.publicEntry && !this.server.listening))
      throw Error('Community entry is not available for database activation')
    try {
      await this.entryStarted
      if (this.stopped) throw Error('Community entry stopped before database activation')
      if (this.ready) return
      if (!this.activation) {
        const task = Promise.resolve().then(async () => {
          await this.deps.prepareBootstrap()
          await this.finishActivation()
        })
        this.activation = task
        this.background.set('database-activation', task)
        void task
          .finally(() => {
            this.background.delete('database-activation')
          })
          .catch(() => {})
      }
      await this.activation
    } catch (error) {
      this.fail()
      throw error
    }
  }
  private async finishActivation(): Promise<void> {
    const knownUsers = await this.deps.knownUsers()
    if (this.stopped || this.failed) throw new Error('Community entry stopped during startup')
    await this.deps.runtime.reconcileStartupContainers(knownUsers, this.origin().host)
    if (this.stopped || this.failed) throw new Error('Community entry stopped during startup')
    await this.deps.startBackgroundWork?.()
    if (this.stopped || this.failed) throw new Error('Community entry stopped during startup')
    this.ready = true
    this.idleTimer = setInterval(() => this.runBackground('idle', this.deps.checkIdle), this.deps.checkIntervalMs ?? 30_000)
    this.idleTimer.unref()
  }
  private runBackground(name: string, operation: () => Promise<void>): void {
    if (this.stopped || this.background.has(name)) return
    const task = Promise.resolve()
      .then(operation)
      .catch(() => {
        console.warn('Community background check failed')
      })
      .finally(() => {
        this.background.delete(name)
      })
    this.background.set(name, task)
  }
  stop(): Promise<void> {
    return (this.stopping ??= this.close())
  }
  private async close(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.ready = false
    if (this.server) this.deps.publicEntry?.unbind(this.server)
    this.releaseEntry()
    if (this.idleTimer !== undefined) clearInterval(this.idleTimer)
    if (this.previewTimer !== undefined) clearInterval(this.previewTimer)
    this.deps.connections.closeAll()
    try {
      await Promise.all(
        [this.server, this.gateway, this.preview].map(async server => {
          if (server?.listening === true)
            await new Promise<void>((resolve, reject) => {
              server.close(error => {
                if (error === undefined) resolve()
                else reject(error)
              })
            })
        }),
      )
    } finally {
      try {
        await this.deps.runtime.stopAll()
      } finally {
        await Promise.allSettled(this.background.values())
        try {
          await this.deps.closeResources()
        } finally {
          this.server = undefined
          this.gateway = undefined
          this.preview = undefined
          this.publicOrigin = undefined
        }
      }
    }
  }
}
