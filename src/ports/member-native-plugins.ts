import type { CommunityUserInstance } from './community-runtime.js'
import type { MemberPluginManagerPort } from './plugin-market.js'

export type NativePluginInstallPhase = 'downloading' | 'installing'
export type NativePluginApplication = 'applied' | 'restart-required'
export interface MemberNativePluginManagerPort extends MemberPluginManagerPort {
  install(instance: CommunityUserInstance, origin: URL, archive: { readonly url: string, readonly integrity: string }, options: { readonly registry: string, readonly requestId: string, readonly progress?: (phase: NativePluginInstallPhase) => void }, signal: AbortSignal): Promise<NativePluginApplication>
  remove(instance: CommunityUserInstance, origin: URL, packageName: string, signal: AbortSignal): Promise<NativePluginApplication>
}
