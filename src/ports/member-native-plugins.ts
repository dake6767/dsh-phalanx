import type { CommunityUserInstance } from './community-runtime.js'
import type { PluginIdentity } from '../domain/plugin-library.js'
import type { CatalogPluginServiceSlot } from '../domain/suite-service-slots.js'
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
    options: {
      readonly registry: string
      readonly requestId: string
      readonly identity?: PluginIdentity
      readonly progress?: (phase: NativePluginInstallPhase) => void
    },
    signal: AbortSignal,
  ): Promise<NativePluginApplication>
  replace?(
    instance: CommunityUserInstance,
    origin: URL,
    archive: { readonly url: string; readonly integrity: string; readonly authorizationUrl: string },
    replacement: NativePluginReplacement,
    options: {
      readonly registry: string
      readonly requestId: string
      readonly identity?: PluginIdentity
      readonly progress?: (phase: NativePluginInstallPhase) => void
    },
    signal: AbortSignal,
  ): Promise<NativePluginApplication>
  remove(instance: CommunityUserInstance, origin: URL, packageName: string, signal: AbortSignal): Promise<NativePluginApplication>
}

export interface NativePluginCache {
  readonly directory: string
  readonly owner: PluginIdentity
  readonly packages: readonly PluginIdentity[]
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
      readonly cache?: NativePluginCache
      readonly replacement?: NativePluginReplacement & { readonly authorizationUrl: string }
    },
    signal: AbortSignal,
  ): Promise<unknown>
}

interface NativeServiceSettingsProjection {
  readonly packageName: string
  readonly version: string
  readonly integrity: string
  readonly binding: CatalogPluginServiceSlot['binding']
  readonly id: string
  readonly fields: Readonly<Record<string, string | boolean>>
  readonly keys: readonly string[]
  readonly previous: readonly (string | null)[]
}
export type NativeServiceSettingsIntent = NativeServiceSettingsProjection &
  ({ readonly phase: 'preview' } | { readonly phase: 'apply'; readonly revision: string | number })
export type NativeServiceSettingsResult =
  | { readonly status: 'prepared'; readonly fingerprint: string; readonly observed: string | null; readonly revision: string | number }
  | { readonly status: 'applied'; readonly fingerprint: string; readonly refresh: boolean }
  | { readonly status: 'failed' | 'conflict' | 'unsupported' }
export interface NativeServiceSettingsTransport {
  syncSettings(instance: CommunityUserInstance, origin: URL, input: NativeServiceSettingsIntent, signal: AbortSignal): Promise<NativeServiceSettingsResult>
}
