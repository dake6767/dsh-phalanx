import type { InstalledNativeResourceBinding } from '../domain/plugin-preinstall.js'

/** Successful deliveries are history, independently of the current native inventory. */
export interface PluginInstallation {
  readonly packageName: string
  readonly source: 'selected' | 'preinstall'
  readonly version: string
  readonly integrity?: string
  /** Present only on platform deliveries made from a trusted installed service definition. */
  readonly serviceOrigin?: string
  readonly resourceOrigin?: string
  readonly browserBindings?: readonly InstalledNativeResourceBinding[]
  readonly serviceSettings?: NativeServiceSettingsHistory
}
export interface PluginInstallationsPort {
  get(spaceId: string): Promise<readonly PluginInstallation[]>
  save(spaceId: string, record: PluginInstallation, browserReservation?: string, expectedServiceGeneration?: string): Promise<void>
  resetForSpace(spaceId: string): Promise<void>
}

export interface MemberBrowserDeliveryPort {
  reserveBrowserDelivery(
    spaceId: string,
    packageName: string,
    binding: { version: string; integrity: string; resourceOrigin: string },
    generation?: string,
  ): Promise<string | undefined>
  releaseBrowserDelivery(reservation: string): Promise<void>
  deferBrowserDelivery(reservation: string): Promise<void>
}

export interface MemberBrowserInventoryPort {
  browserDeliveries(spaceId: string, generation: string): Promise<readonly { packageName: string; version: string; integrity: string; revision: string }[]>
  releaseMissingBrowserDeliveries(spaceId: string, revisions: readonly string[], generation: string): Promise<void>
  isBrowserArchiveReserved?(spaceId: string, integrity: string): Promise<boolean>
}

export interface RecoverableMemberBrowser {
  readonly packageName: string
  readonly version: string
  readonly integrity: string
  readonly resourceOrigin: string
  readonly browserBindings: readonly InstalledNativeResourceBinding[]
}

export interface MemberNativeResourceSnapshot {
  readonly delivered: readonly Pick<PluginInstallation, 'packageName' | 'version' | 'integrity' | 'resourceOrigin' | 'browserBindings'>[]
  readonly recovering: readonly RecoverableMemberBrowser[]
}

export interface MemberNativeResourcesPort {
  nativeResourceSnapshot(spaceId: string): Promise<MemberNativeResourceSnapshot>
}

export const nativeJsonSettingsHistoryKey = '@json-settings'

export type NativeJsonFieldState = { readonly applied: string | null; readonly pending?: string } | { readonly detached: true }
export type NativeJsonFieldHistory = Readonly<Record<string, NativeJsonFieldState>>

export type NativeServiceSettingsHistory = Readonly<
  Record<
    string,
    {
      readonly contract: string
      readonly applied: string | null
      readonly pending?: string
      readonly jsonFiles?: Readonly<Record<string, NativeJsonFieldHistory>>
    }
  >
>

export interface PluginServiceSettingsHistoryPort {
  replaceServiceSettings(spaceId: string, expected: PluginInstallation, next: NativeServiceSettingsHistory): Promise<boolean>
}

export interface PluginJsonSettingsSummaryPort {
  personalJsonFields(packageName: string, serviceOrigin: string): Promise<readonly { file: string; path: string }[]>
}
