import type { CommunityUserInstance } from './community-runtime.js'
import type { MemberPluginManagerPort } from './plugin-market.js'

export type NativePluginInstallPhase = 'downloading' | 'installing'
export type NativePluginApplication = 'applied' | 'restart-required'
export interface NativePluginReplacement {
  readonly packageName: string
  readonly previous: { readonly version: string; readonly integrity: string; readonly enabled: boolean }
  readonly next: { readonly version: string; readonly integrity: string }
}
export interface MemberNativePluginManagerPort extends MemberPluginManagerPort {
  install(
    instance: CommunityUserInstance,
    origin: URL,
    archive: { readonly url: string; readonly integrity: string },
    options: { readonly registry: string; readonly requestId: string; readonly progress?: (phase: NativePluginInstallPhase) => void },
    signal: AbortSignal,
  ): Promise<NativePluginApplication>
  replace?(
    instance: CommunityUserInstance,
    origin: URL,
    archive: { readonly url: string; readonly integrity: string; readonly authorizationUrl: string },
    replacement: NativePluginReplacement,
    options: { readonly registry: string; readonly requestId: string; readonly progress?: (phase: NativePluginInstallPhase) => void },
    signal: AbortSignal,
  ): Promise<NativePluginApplication>
  remove(instance: CommunityUserInstance, origin: URL, packageName: string, signal: AbortSignal): Promise<NativePluginApplication>
}

/** Platform-only native installation capability, separate from ordinary member RPC. */
export interface NativePluginInstallTransport {
  install(
    instance: CommunityUserInstance,
    origin: URL,
    input: {
      readonly spec: string
      readonly registry: string
      readonly requestId: string
      readonly replacement?: NativePluginReplacement & { readonly authorizationUrl: string }
    },
    signal: AbortSignal,
  ): Promise<unknown>
}
