/** Single management wire contract for the server and browser. Types only. */
import type { CommunityCreateAccountInput } from './community-account.js'

export type InstanceState = 'stopped' | 'starting' | 'ready' | 'draining'

export interface CommunitySessionInfo {
  readonly username: string
  readonly admin: boolean
}
/** Ordinary members may read only their own platform display identity. */
export interface CommunitySelfIdentity { readonly username: string }

export interface CommunityManagementSession extends CommunitySessionInfo {
  readonly modelState: 'unconfigured' | 'configured'
}

export interface CommunityAccountView extends CommunitySessionInfo {
  readonly spaceId: string
  readonly email: string
  readonly disabled: boolean
  readonly instance: { readonly state: InstanceState }
}

export interface CommunityAccountsPageData {
  readonly total: number
  readonly page: number
  readonly pageCount: number
  readonly items: readonly CommunityAccountView[]
}

export type CommunityCreateAccountRequest = CommunityCreateAccountInput

export type CommunityErrorCode =
  | 'password-required'
  | 'last-admin-required'
  | 'username-invalid'
  | 'email-invalid'
  | 'origin-forbidden'
  | 'account-request-invalid'
  | 'account-fields-invalid'
  | 'account-action-invalid'
  | 'account-action-unknown'
  | 'account-action-fields-unexpected'
  | 'account-action-fields-invalid'
  | 'json-invalid'
  | 'media-type-unsupported'
  | 'request-too-large'
  | 'request-interrupted'
  | 'update-query-invalid'
  | 'model-action-invalid'
  | 'account-path-invalid'
  | 'restart-confirmation-required'
  | 'update-action-invalid'
  | 'update-release-required'
  | 'update-confirmation-required'
  | 'update-operation-required'
  | 'sign-in-required'
  | 'admin-required'
  | 'email-in-use'
  | 'account-not-found'
  | 'bootstrap-complete'
  | 'username-in-use'
  | 'model-revision-conflict'
  | 'not-found'
  | 'bootstrap-credential-invalid'
  | 'environment-account-disabled'
  | 'environment-space-changed'
  | 'account-inactive'
  | 'credentials-invalid'
  | 'provider-not-found'
  | 'model-default-required'
  | 'provider-invalid'
  | 'method-not-allowed'
  | 'internal-error'
  | 'request-failed'
  | 'account-stop-failed'
  | 'update-service-unavailable'
  | 'update-request-refused'
  | 'runtime-draining'
  | 'runtime-shutdown'
  | 'runtime-start-cancelled'
  | 'runtime-authorization-unavailable'
  | 'runtime-profile-unavailable'
  | 'runtime-storage-unavailable'
  | 'runtime-startup-unavailable'
  | 'runtime-upgrade-unavailable'
  | 'environment-recovery-failed'

export type CommunityErrorParams = Readonly<Record<string, string | number | boolean>>

export interface CommunityApiErrorBody {
  readonly error: string
  readonly code: CommunityErrorCode
  readonly params?: CommunityErrorParams
}

export type CommunityAccountActionRequest = { readonly action: 'reset-password', readonly password: string }
  | { readonly action: 'set-email', readonly email: string }
  | { readonly action: 'set-disabled', readonly disabled: boolean }
  | { readonly action: 'set-admin', readonly admin: boolean }
  | { readonly action: 'delete' }

export type CommunityAccountActionResult =
  | { readonly kind: 'updated', readonly account: CommunityAccountView }
  | { readonly kind: 'deleted', readonly username: string, readonly userSpace: 'preserved' }

export interface CommunityProviderInput {
  readonly id?: string
  readonly name: string
  readonly baseUrl: string
  readonly apiFormat: 'anthropic-messages'
  readonly apiKey?: string
  readonly enabled: boolean
  readonly models: readonly { readonly id?: string, readonly name: string, readonly enabled: boolean }[]
}
export interface CommunityProviderView extends Omit<CommunityProviderInput, 'id' | 'apiKey' | 'models'> {
  readonly id: string
  readonly hasApiKey: boolean
  readonly models: readonly { readonly id: string, readonly name: string, readonly enabled: boolean }[]
}
export interface CommunityModelSettings {
  readonly revision: number
  readonly providers: readonly CommunityProviderView[]
  readonly defaultModelId: string | null
}
export type CommunityModelAction = { readonly revision: number, readonly defaultModelId?: string | null } & (
  { readonly action: 'save-provider', readonly provider: CommunityProviderInput }
  | { readonly action: 'delete-provider', readonly providerId: string }
  | { readonly action: 'set-default', readonly defaultModelId: string | null })
export interface CommunityRestartResult { readonly entry: string }

export interface CommunityEnvironmentBackup {
  readonly id: string
  readonly location: string
  readonly restoreInstructions: string
  readonly restoreInstructionsPath?: string
}
export interface CommunityEnvironmentResetResult {
  readonly username: string
  readonly spaceId: string
  readonly entry: string
  readonly backup: CommunityEnvironmentBackup
}
export interface CommunityEnvironmentResetRequest { readonly confirmed: true }
export interface CommunityEnvironmentResetFailure extends CommunityApiErrorBody {
  readonly phase: 'stop' | 'backup' | 'reset' | 'start'
  readonly backup?: CommunityEnvironmentBackup
}

export type CommunitySystemUpdatePhase = 'preparing' | 'prepared' | 'prepare-failed' | 'stopping' | 'backing-up'
  | 'backed-up' | 'switching' | 'validating' | 'committed' | 'succeeded' | 'restoring' | 'restoration-committed'
  | 'restored' | 'apply-failed' | 'recovery-failed'
export interface CommunitySystemUpdateOperation {
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
export type CommunitySystemUpdateCheck = {
  readonly status: 'available' | 'current' | 'incompatible'
  readonly checkedAt: string
  readonly version: string
  readonly manifestSha256: string
  readonly releaseNotes: string
  readonly reason?: string
} | { readonly status: 'failed' | 'stale', readonly checkedAt: string, readonly reason: string }
export interface CommunitySystemUpdateCheckResult extends CommunitySystemUpdateStatus {
  readonly check: CommunitySystemUpdateCheck
}
export interface CommunitySystemUpdateSubmission { readonly operation: CommunitySystemUpdateOperation }
export type CommunitySystemUpdateAction = { readonly action: 'check' }
  | { readonly action: 'prepare', readonly version: string, readonly manifestSha256: string }
  | { readonly action: 'apply', readonly operation: string, readonly confirmed: true }
