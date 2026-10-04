import type { CommunityEnvironmentBackup } from '../domain/admin-contract.js'

export type CommunityEnvironmentUpgradeState = { readonly state: 'new' | 'legacy' }
  | { readonly state: 'complete', readonly selectSharedModel: boolean }
export interface CommunityEnvironmentUpgradeStorePort {
  inspect(username: string, spaceId: string): Promise<CommunityEnvironmentUpgradeState>
  complete(username: string, spaceId: string, result: { readonly selectSharedModel: boolean, readonly backup?: CommunityEnvironmentBackup }): Promise<void>
}
/** Before profile preparation and native startup, after removal of the old carrier. */
export interface CommunityEnvironmentUpgradePort {
  prepare(username: string, spaceId: string): Promise<{ readonly selectSharedModel: boolean }>
}
