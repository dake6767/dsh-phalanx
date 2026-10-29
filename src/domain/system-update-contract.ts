/** System update wire types, re-exported by the management contract. */
export type CommunitySystemUpdatePhase =
  | 'preparing'
  | 'prepared'
  | 'prepare-failed'
  | 'stopping'
  | 'backing-up'
  | 'backed-up'
  | 'switching'
  | 'validating'
  | 'committed'
  | 'succeeded'
  | 'restoring'
  | 'restoration-committed'
  | 'restored'
  | 'apply-failed'
  | 'recovery-failed'
export interface CommunitySystemUpdateSpace {
  readonly sufficient: boolean
  readonly backupBytes: number
  readonly locations: readonly {
    readonly paths: readonly string[]
    readonly purposes: readonly string[]
    readonly availableBytes: number
    readonly requiredBytes: number
    readonly shortfallBytes: number
  }[]
}
export interface CommunitySystemUpdateCleanup {
  readonly omittedItems?: number
  readonly status: 'running' | 'succeeded' | 'failed'
  readonly reclaimedBytes: number
  readonly failure?: string
  readonly items: readonly {
    readonly kind: string
    readonly name: string
    readonly status: 'pending' | 'removed' | 'retained' | 'failed'
    readonly reason: string
    readonly reclaimedBytes: number
  }[]
}
export interface CommunitySystemUpdateOperation {
  readonly cleanup?: CommunitySystemUpdateCleanup
  readonly space?: CommunitySystemUpdateSpace
  readonly id: string
  readonly phase: CommunitySystemUpdatePhase
  readonly targetVersion: string
  readonly sourceVersion: string
  readonly targetCommit: string
  readonly platformSha256: string
  readonly imageDigest: string
  readonly failure?: string
  readonly recoveryFailure?: string
  readonly stopFailure?: string
  readonly instruction?: string
}
export interface CommunitySystemUpdateEvent {
  readonly action?: string
  readonly elapsed?: number
  readonly phaseElapsed?: number
  readonly phase: string
  readonly status: string
  readonly message: string
  readonly bytes?: number
  readonly total?: number
}
export interface CommunitySystemUpdateStatus {
  readonly currentVersion: string | null
  readonly runningVersion: string | null
  readonly operation: CommunitySystemUpdateOperation | null
  readonly events: readonly CommunitySystemUpdateEvent[]
}
export type CommunitySystemUpdateCheck =
  | {
      readonly freshInstallRequired?: boolean
      readonly status: 'available' | 'current' | 'incompatible'
      readonly checkedAt: string
      readonly version: string
      readonly manifestSha256: string
      readonly releaseNotes: string
      readonly reason?: string
    }
  | { readonly status: 'failed' | 'stale'; readonly checkedAt: string; readonly reason: string }
export interface CommunitySystemUpdateCheckResult extends CommunitySystemUpdateStatus {
  readonly check: CommunitySystemUpdateCheck
}
export interface CommunitySystemUpdateSubmission {
  readonly operation: CommunitySystemUpdateOperation
}
export type CommunitySystemUpdateAction =
  | { readonly action: 'check' }
  | { readonly action: 'prepare'; readonly version: string; readonly manifestSha256: string }
  | { readonly action: 'cleanup'; readonly operation: string }
  | { readonly action: 'apply'; readonly operation: string; readonly confirmed: true }
