/** Single management wire contract for the server and browser. Types only. */
import type { CommunityCreateAccountInput } from './community-account.js'

export type InstanceState = 'stopped' | 'starting' | 'ready' | 'draining'

export interface CommunitySessionInfo {
  readonly username: string
  readonly admin: boolean
}

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

export interface CommunityApiErrorBody {
  readonly error: string
}

export type CommunityAccountActionRequest = { readonly action: 'reset-password', readonly password: string }
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
