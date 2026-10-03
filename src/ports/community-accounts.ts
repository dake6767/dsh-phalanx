import type { CommunityAccountRecord, CommunityAccountState, CommunityCreateAccountInput } from '../domain/community-account.js'

/** Read current access on every request; missing means deleted or unknown. */
export interface CommunityAccountStatePort {
  getState(username: string): CommunityAccountState | undefined
}

export interface CommunityAccountReaderPort extends CommunityAccountStatePort {
  get(username: string): CommunityAccountRecord | undefined
}

/** Account creation and bootstrap capabilities. */
export interface CommunityAccountOnboardingStorePort extends CommunityAccountReaderPort {
  list(): readonly CommunityAccountRecord[]
  create(input: CommunityCreateAccountInput): Promise<CommunityAccountRecord>
  createFirstAdmin(input: CommunityCreateAccountInput): Promise<CommunityAccountRecord>
  authenticate(username: string, password: string): Promise<CommunityAccountRecord | undefined>
  bootstrapComplete(): boolean
}

/** Community persistence boundary. Lifecycle side effects belong to use cases. */
export interface CommunityAccountStorePort extends CommunityAccountOnboardingStorePort {
  /** Replacing a password invalidates all previously issued sessions. */
  resetPassword(username: string, password: string): Promise<void>
  /** Disabling advances the session epoch; enabling never restores old sessions. */
  setDisabled(username: string, disabled: boolean): Promise<CommunityAccountRecord>
  setAdmin(username: string, admin: boolean): Promise<CommunityAccountRecord>
  /** Preserve user-space data and reserve its identity against later reuse. */
  delete(username: string): Promise<void>
}
