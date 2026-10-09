import type { CommunityUserInstance } from './community-runtime.js'
export interface InstalledMarketPlugin { readonly packageName: string, readonly version: string }
export interface MemberPluginManagerPort {
  list(instance: CommunityUserInstance, origin: URL, signal: AbortSignal): Promise<readonly InstalledMarketPlugin[]>
  install(instance: CommunityUserInstance, origin: URL, archiveUrl: string, integrity: string, signal: AbortSignal): Promise<'applied' | 'restart-required'>
}
export interface PluginDownloadGrant { readonly username: string, readonly spaceId: string, readonly integrity: string, readonly expiresAt: number }
export interface PluginDownloadTokensPort {
  issue(grant: PluginDownloadGrant): string
  read(token: string): PluginDownloadGrant | undefined
}
export interface PluginArchiveReadPort {
  open(artifact: string): Promise<{ readonly size: number, readonly body: AsyncIterable<Uint8Array> }>
}
