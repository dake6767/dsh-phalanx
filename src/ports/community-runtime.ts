/** One DSH instance owned by a stable user-space identity. Internal to the platform. */
export interface CommunityUserInstance {
  readonly userId: string
  readonly origin: string
  readonly launchUrl: string
  readonly processId: number
  readonly containerName?: string
}

export type CommunityRuntimeStatus =
  | { readonly state: 'stopped' | 'starting' }
  | { readonly state: 'ready' | 'draining', readonly instance: CommunityUserInstance }

export interface CommunityStartupReconciliation {
  readonly adopted: readonly string[]
  readonly swept: readonly string[]
}

export type CommunityReclaimResult = 'reclaimed' | 'busy' | 'not-running' | 'already-draining'

/** Per-user access to the default route; shared upstream credentials never enter this value. */
export interface CommunityModelGatewayAccess {
  readonly url: string
  readonly token: string
}

export class CommunityRuntimeUnavailableError extends Error {
  constructor(readonly reason: 'draining' | 'shutdown' | 'start-cancelled' | 'authorization-unavailable' | 'profile-unavailable' | 'storage-unavailable' | 'startup-unavailable' | 'upgrade-unavailable',
    message: string, options?: ErrorOptions) { super(message, options) }
}

/** Instance lifecycle only. Its owner receives the per-user default gateway source at construction. */
export interface CommunityRuntimePort {
  reconcileStartupContainers(knownUsers: ReadonlySet<string>, publicAuthority: string): Promise<CommunityStartupReconciliation>
  /** Concurrent entries share at most one instance per user. */
  ensure(userId: string, publicOriginUrl: string): Promise<CommunityUserInstance>
  /** Fence entry, stop the current carrier and start one replacement. */
  restart(userId: string, publicOriginUrl: string): Promise<CommunityUserInstance>
  /** Stop, run backup/reset inside the maintenance fence, then start one replacement. */
  recover(userId: string, publicOriginUrl: string, afterStopped: () => Promise<void>): Promise<CommunityUserInstance>
  /** Fence new entry while checking activity; stop only when the check confirms. */
  reclaim(userId: string, prepare: (instance: CommunityUserInstance) => Promise<boolean>): Promise<CommunityReclaimResult>
  /** Cancel a pending start or stop active work; resolve only after the instance is gone. */
  terminate(userId: string): Promise<void>
  status(userId: string): CommunityRuntimeStatus
  /** Release owner state. Containers survive for startup reconciliation; development processes stop. */
  stopAll(): Promise<void>
}
