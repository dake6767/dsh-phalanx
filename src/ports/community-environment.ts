import type { CommunityEnvironmentBackup } from '../domain/admin-contract.js'

/** Called inside the runtime maintenance fence, with its carrier fully stopped. */
export interface CommunityEnvironmentPort {
  backup(username: string, spaceId: string): Promise<CommunityEnvironmentBackup>
  reset(username: string, spaceId: string, backup: CommunityEnvironmentBackup): Promise<void>
}
