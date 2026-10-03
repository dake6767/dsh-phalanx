/** Single management wire contract for the server and browser. Types only. */
import type { CommunityCreateAccountInput } from './community-account.js'

export type InstanceState = 'stopped' | 'starting' | 'ready' | 'draining'

export interface CommunitySessionInfo {
  readonly username: string
  readonly admin: boolean
}

export interface CommunityAccountView extends CommunitySessionInfo {
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
