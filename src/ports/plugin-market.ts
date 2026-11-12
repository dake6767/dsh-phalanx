import type { CommunityUserInstance } from './community-runtime.js'
export interface InstalledMarketPlugin {
  readonly packageName: string
  readonly version?: string
  readonly retainedArchive?: true
  readonly archiveIntegrity?: string
  readonly enabled?: boolean
}
export interface MemberPluginManagerPort {
  verifyArchive?(instance: CommunityUserInstance, packageName: string, integrity: string, signal: AbortSignal): Promise<boolean>
  list(instance: CommunityUserInstance, origin: URL, signal: AbortSignal): Promise<readonly InstalledMarketPlugin[]>
}
