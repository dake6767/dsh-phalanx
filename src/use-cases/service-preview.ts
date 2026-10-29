import type { CommunityAccountRegistration, CommunityAccountStatePort } from '../ports/community-accounts.js'
import type { CommunityAccountState } from '../domain/community-account.js'
import type { CommunityRuntimePort } from '../ports/community-runtime.js'
import type { Clock } from '../ports/clock.js'
import { ServicePreviewError, type PreviewIdentity, type PreviewTarget, type PreviewCapabilityPort } from '../ports/service-preview.js'

/** Owns preview revocations, connection lifetimes and trusted gesture timestamps. */
export class ServicePreview {
  private readonly leases = new Map<string, PreviewTarget>()
  private readonly revoked = new Map<string, number>()
  private revokedBeforeExpiry = 0
  private readonly channels = new Map<() => void, PreviewTarget>()
  private readonly activity = new Map<string, { instance: PreviewTarget['instance']; at: number }>()
  private closed = false
  constructor(
    private readonly accounts: CommunityAccountStatePort,
    private readonly runtime: Pick<CommunityRuntimePort, 'status'>,
    private readonly clock: Clock,
    private readonly excludedPorts: readonly number[],
    private readonly capabilities: PreviewCapabilityPort,
  ) {}

  suggestedPort(): number {
    let port = 4300
    while (this.excludedPorts.includes(port)) port++
    return port
  }

  async admit(identity: PreviewIdentity | undefined, spaceId: string, port: number): Promise<PreviewTarget> {
    if (
      !identity ||
      identity.spaceId !== spaceId ||
      !(await this.validIdentity(identity)) ||
      !Number.isInteger(port) ||
      port < 1024 ||
      port > 65535 ||
      this.excludedPorts.includes(port)
    ) {
      throw new ServicePreviewError(403, 'Preview access expired or the target is not allowed. Sign in to your own space.')
    }
    const status = this.runtime.status(identity.userId)
    if (status.state !== 'ready' || !status.instance.containerName) {
      throw new ServicePreviewError(503, 'Your instance is stopped. Open your workspace, start the service again, then reload this preview.')
    }
    return { identity, instance: status.instance, port }
  }

  /** Only the authenticated platform wrapper may mint a lease. Applications cannot renew it. */
  async issue(identity: PreviewIdentity, spaceId: string, port: number): Promise<string> {
    const target = await this.admit(identity, spaceId, port)
    await this.sweep()
    return await this.register(target, (_account, onAbort) => {
      for (const [key, existing] of this.leases)
        if (existing.identity.key === identity.key && existing.port === port && existing.instance === target.instance) return key
      if (this.leases.size >= 1024) throw new ServicePreviewError(503, 'Too many active previews. Sign out of unused sessions and retry.')
      const key = this.capabilities.issue()
      onAbort(() => {
        this.leases.delete(key)
      })
      this.leases.set(key, target)
      return key
    })
  }
  async resolve(key: string, spaceId: string, port: number, ambientIdentity?: PreviewIdentity): Promise<PreviewTarget> {
    const target = this.leases.get(key)
    if (
      !target ||
      target.identity.spaceId !== spaceId ||
      target.port !== port ||
      (ambientIdentity && ambientIdentity.key !== target.identity.key) ||
      !(await this.current(target))
    ) {
      throw new ServicePreviewError(403, 'Preview access expired. Sign in, open your workspace and restart the service before reopening.')
    }
    return target
  }

  async current(target: PreviewTarget): Promise<boolean> {
    return this.validTarget(target, await this.accounts.getState(target.identity.userId))
  }

  /** The database fence orders account mutations and the synchronous registration. */
  async track(target: PreviewTarget, close: () => void): Promise<() => void> {
    return await this.register(target, (_account, onAbort) => {
      onAbort(() => {
        this.channels.delete(close)
        close()
      })
      this.channels.set(close, target)
      return () => {
        this.channels.delete(close)
      }
    })
  }

  async gesture(target: PreviewTarget): Promise<void> {
    await this.register(target, (_account, onAbort) => {
      const userId = target.identity.userId,
        previous = this.activity.get(userId)
      const next = { instance: target.instance, at: this.clock.now() }
      onAbort(() => {
        if (this.activity.get(userId) !== next) return
        if (previous) this.activity.set(userId, previous)
        else this.activity.delete(userId)
      })
      this.activity.set(userId, next)
    })
  }
  lastActivity(userId: string): number | undefined {
    const value = this.activity.get(userId),
      status = this.runtime.status(userId)
    return status.state === 'ready' && status.instance === value?.instance ? value.at : undefined
  }
  revoke(identity: PreviewIdentity): void {
    if (this.closed) return
    this.prune()
    this.revoked.set(identity.key, identity.expiresAt)
    // A bounded fail-closed watermark replaces a full revocation cache.
    if (this.revoked.size > 4096) {
      this.revokedBeforeExpiry = Math.max(this.revokedBeforeExpiry, ...this.revoked.values())
      this.revoked.clear()
    }
    this.sweepLocal()
  }
  async sweep(): Promise<void> {
    if (this.closed) return
    this.sweepLocal()
    for (const [key, target] of this.leases) if (!(await this.current(target))) this.leases.delete(key)
    for (const [close, target] of this.channels) if (!(await this.current(target)) && this.channels.delete(close)) close()
    for (const userId of this.activity.keys()) if (this.lastActivity(userId) === undefined) this.activity.delete(userId)
  }
  close(): void {
    this.closed = true
    for (const close of this.channels.keys()) close()
    this.channels.clear()
    this.activity.clear()
    this.revoked.clear()
    this.leases.clear()
  }
  private prune(): void {
    for (const [key, expiry] of this.revoked) if (expiry <= this.clock.now()) this.revoked.delete(key)
  }
  private async validIdentity(identity: PreviewIdentity): Promise<boolean> {
    return this.validAccount(identity, await this.accounts.getState(identity.userId))
  }
  private validAccount(identity: PreviewIdentity, account: CommunityAccountState | undefined): boolean {
    return (
      this.validLocalIdentity(identity) &&
      account !== undefined &&
      !account.disabled &&
      account.spaceId === identity.spaceId &&
      account.sessionEpoch === identity.sessionEpoch
    )
  }
  private validLocalIdentity(identity: PreviewIdentity): boolean {
    return !this.closed && identity.expiresAt > this.clock.now() && identity.expiresAt > this.revokedBeforeExpiry && !this.revoked.has(identity.key)
  }
  private sweepLocal(): void {
    this.prune()
    const current = (target: PreviewTarget) => {
      const status = this.runtime.status(target.identity.userId)
      return this.validLocalIdentity(target.identity) && status.state === 'ready' && status.instance === target.instance
    }
    for (const [key, target] of this.leases) if (!current(target)) this.leases.delete(key)
    for (const [close, target] of this.channels) if (!current(target) && this.channels.delete(close)) close()
  }
  private validTarget(target: PreviewTarget, account: CommunityAccountState | undefined): boolean {
    const status = this.runtime.status(target.identity.userId)
    return this.validAccount(target.identity, account) && status.state === 'ready' && status.instance === target.instance
  }
  private async register<T>(target: PreviewTarget, operation: CommunityAccountRegistration<T>): Promise<T> {
    return await this.accounts.withCurrentState(target.identity.userId, (account, onAbort) => {
      if (!this.validTarget(target, account)) throw new ServicePreviewError(403, 'Preview access changed. Sign in and reopen your preview.')
      return operation(account, onAbort)
    })
  }
}
