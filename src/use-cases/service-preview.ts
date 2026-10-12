import type { CommunityAccountStatePort } from '../ports/community-accounts.js'
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
  constructor(private readonly accounts: CommunityAccountStatePort,
    private readonly runtime: Pick<CommunityRuntimePort, 'status'>,
    private readonly clock: Clock, private readonly excludedPorts: readonly number[], private readonly capabilities: PreviewCapabilityPort) {}

  suggestedPort(): number {
    let port = 4300
    while (this.excludedPorts.includes(port)) port++
    return port
  }

  admit(identity: PreviewIdentity | undefined, spaceId: string, port: number): PreviewTarget {
    if (!identity || identity.spaceId !== spaceId || !this.validIdentity(identity)
      || !Number.isInteger(port) || port < 1024 || port > 65535 || this.excludedPorts.includes(port)) {
      throw new ServicePreviewError(403, 'Preview access expired or the target is not allowed. Sign in to your own space.')
    }
    const status = this.runtime.status(identity.userId)
    if (status.state !== 'ready' || !status.instance.containerName) {
      throw new ServicePreviewError(503, 'Your instance is stopped. Open your workspace, start the service again, then reload this preview.')
    }
    return { identity, instance: status.instance, port }
  }

  /** Only the authenticated platform wrapper may mint a lease. Applications cannot renew it. */
  issue(identity: PreviewIdentity, spaceId: string, port: number): string {
    const target = this.admit(identity, spaceId, port)
    this.sweep()
    for (const [key, existing] of this.leases) if (existing.identity.key === identity.key && existing.port === port && existing.instance === target.instance) return key
    if (this.leases.size >= 1024) throw new ServicePreviewError(503, 'Too many active previews. Sign out of unused sessions and retry.')
    const key = this.capabilities.issue()
    this.leases.set(key, target)
    return key
  }
  resolve(key: string, spaceId: string, port: number, ambientIdentity?: PreviewIdentity): PreviewTarget {
    const target = this.leases.get(key)
    if (!target || target.identity.spaceId !== spaceId || target.port !== port
      || ambientIdentity && ambientIdentity.key !== target.identity.key || !this.current(target)) {
      throw new ServicePreviewError(403, 'Preview access expired. Sign in, open your workspace and restart the service before reopening.')
    }
    return target
  }

  current(target: PreviewTarget): boolean {
    const status = this.runtime.status(target.identity.userId)
    return this.validIdentity(target.identity) && status.state === 'ready' && status.instance === target.instance
  }

  /** Synchronous final fence: no await may separate this check from registration. */
  track(target: PreviewTarget, close: () => void): () => void {
    if (!this.current(target)) throw new ServicePreviewError(403, 'Preview access changed. Sign in and reopen your preview.')
    this.channels.set(close, target)
    return () => { this.channels.delete(close) }
  }

  gesture(target: PreviewTarget): void {
    if (!this.current(target)) throw new ServicePreviewError(403, 'Preview access changed.')
    this.activity.set(target.identity.userId, { instance: target.instance, at: this.clock.now() })
  }
  lastActivity(userId: string): number | undefined {
    const value = this.activity.get(userId), status = this.runtime.status(userId)
    return status.state === 'ready' && status.instance === value?.instance ? value.at : undefined
  }
  revoke(identity: PreviewIdentity): void {
    this.prune()
    this.revoked.set(identity.key, identity.expiresAt)
    // A bounded fail-closed watermark replaces a full revocation cache.
    if (this.revoked.size > 4096) {
      this.revokedBeforeExpiry = Math.max(this.revokedBeforeExpiry, ...this.revoked.values())
      this.revoked.clear()
    }
    this.sweep()
  }
  sweep(): void {
    this.prune()
    for (const [key, target] of this.leases) if (!this.current(target)) this.leases.delete(key)
    for (const [close, target] of this.channels) if (!this.current(target)) { this.channels.delete(close); close() }
    for (const userId of this.activity.keys()) if (this.lastActivity(userId) === undefined) this.activity.delete(userId)
  }
  close(): void { for (const close of this.channels.keys()) close(); this.channels.clear(); this.activity.clear(); this.revoked.clear(); this.leases.clear() }
  private prune(): void { for (const [key, expiry] of this.revoked) if (expiry <= this.clock.now()) this.revoked.delete(key) }
  private validIdentity(identity: PreviewIdentity): boolean {
    const account = this.accounts.getState(identity.userId)
    return identity.expiresAt > this.clock.now() && identity.expiresAt > this.revokedBeforeExpiry
      && !this.revoked.has(identity.key) && account !== undefined && !account.disabled
      && account.spaceId === identity.spaceId && account.sessionEpoch === identity.sessionEpoch
  }
}
