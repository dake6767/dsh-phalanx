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
  readonly errorCode?: string
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
export interface CommunitySystemUpdateTiming {
  readonly phaseSeconds: Readonly<Record<string, number>>
  readonly phaseElapsedSeconds: number
  readonly downtimeSeconds?: number
  readonly downtimeActive: boolean
}
export interface CommunitySystemUpdateOperation {
  readonly phaseCode?: string
  readonly failurePhase?: string
  readonly errorCode?: string
  readonly recoveryErrorCode?: string
  readonly stopErrorCode?: string
  readonly diagnosticLog?: string
  readonly timing?: CommunitySystemUpdateTiming
  readonly previousDowntimeSeconds?: number
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
  readonly phaseCode?: string
  readonly errorCode?: string
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
  readonly previousDowntimeSeconds?: number
  readonly currentVersion: string | null
  readonly runningVersion: string | null
  readonly operation: CommunitySystemUpdateOperation | null
  readonly events: readonly CommunitySystemUpdateEvent[]
}
export type CommunitySystemUpdateOutcomeCode =
  | 'update.available'
  | 'update.current'
  | 'update.breakpoint-required'
  | 'update.below-floor'
  | 'update.channel-switch'
  | 'update.reader-update-required'
  | 'compatibility.unsupported'
export interface CommunitySystemUpdateConclusion {
  readonly diagnosticLog?: string
  readonly errorCode?: string
  readonly outcomeCode?: CommunitySystemUpdateOutcomeCode
  readonly requiredVersion?: string
}
export interface CommunitySystemUpdateVersion extends CommunitySystemUpdateConclusion {
  readonly targetVersion?: string
  readonly freshInstallRequired?: boolean
  readonly status: 'available' | 'current' | 'incompatible'
  readonly version: string
  readonly manifestSha256: string
  readonly releaseNotes?: string
  readonly reason?: string
}
export type CommunitySystemUpdateCheck =
  | (CommunitySystemUpdateVersion & { readonly releaseNotes: string; readonly checkedAt: string; readonly versions?: readonly CommunitySystemUpdateVersion[] })
  | (CommunitySystemUpdateConclusion & { readonly status: 'failed' | 'stale'; readonly checkedAt: string; readonly reason: string })
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
