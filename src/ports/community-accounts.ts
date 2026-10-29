import type { CommunityGroupRecord } from '../domain/community-group.js'
import type { CommunityAccountRecord, CommunityAccountState, CommunityCreateAccountInput } from '../domain/community-account.js'

/** Register reversible admission effects while the current account is protected from mutation. */
export type CommunityAccountRegistration<T> = (
  account: CommunityAccountRecord | undefined,
  onAbort: (cleanup: () => void) => void,
) => T & (T extends PromiseLike<unknown> ? never : unknown)

/** Read current access on every request; missing means deleted or unknown. */
export interface CommunityAccountStatePort {
  getState(username: string): Promise<CommunityAccountState | undefined>
  /** Hold the database's current-account lock through a synchronous, reversible registration. */
  withCurrentState<T>(username: string, register: CommunityAccountRegistration<T>): Promise<T>
}

export interface CommunityAccountReaderPort extends CommunityAccountStatePort {
  get(username: string): Promise<CommunityAccountRecord | undefined>
}

/** Account creation and bootstrap capabilities. */
export interface CommunityAccountOnboardingStorePort extends CommunityAccountReaderPort {
  list(): Promise<readonly CommunityAccountRecord[]>
  create(input: CommunityCreateAccountInput): Promise<CommunityAccountRecord>
  createFirstAdmin(input: CommunityCreateAccountInput): Promise<CommunityAccountRecord>
  authenticate(username: string, password: string): Promise<CommunityAccountRecord | undefined>
  bootstrapComplete(): Promise<boolean>
}

/** Community persistence boundary. Lifecycle side effects belong to use cases. */
export interface CommunityAccountStorePort extends CommunityAccountOnboardingStorePort {
  listGroups(): Promise<readonly CommunityGroupRecord[]>
  createGroup(name: string): Promise<CommunityGroupRecord>
  renameGroup(id: string, name: string): Promise<CommunityGroupRecord>
  deleteGroup(id: string): Promise<void>
  setDefaultGroup(id: string): Promise<void>
  /** Replacing a password invalidates all previously issued sessions. */
  resetPassword(username: string, password: string): Promise<void>
  /** Disabling advances the session epoch; enabling never restores old sessions. */
  setDisabled(username: string, disabled: boolean): Promise<CommunityAccountRecord>
  /** Atomically changes contact information and optional group without revoking access or replacing the user space. */
  setAccountDetails(username: string, email: string, groupId?: string): Promise<CommunityAccountRecord>
  setAdmin(username: string, admin: boolean, groupId?: string): Promise<CommunityAccountRecord>
  /** Preserve the old user space; a recreated username receives a new space identity. */
  delete(username: string): Promise<void>
}
