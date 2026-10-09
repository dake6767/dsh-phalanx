import type { CommunityUserInstance } from './community-runtime.js'
export interface InstalledMarketPlugin { readonly packageName: string, readonly version: string }
export interface MemberPluginManagerPort {
  list(instance: CommunityUserInstance, origin: URL, signal: AbortSignal): Promise<readonly InstalledMarketPlugin[]>
}
