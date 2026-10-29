import type { CommunitySystemStatusView } from '../domain/system-status-contract.js'

export interface CommunitySystemStatusPort {
  read(): Promise<CommunitySystemStatusView>
  /** Compare the current registry and persist the acknowledgement in the same transaction. */
  confirmBackup(fingerprint: string, actor: { readonly username: string; readonly spaceId: string }): Promise<CommunitySystemStatusView>
}
