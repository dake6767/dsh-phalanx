/** Successful deliveries are history, independently of the current native inventory. */
export interface PluginInstallation {
  readonly packageName: string
  readonly source: 'selected' | 'preinstall'
  readonly version: string
  readonly integrity?: string
  /** Present only on platform deliveries made from a trusted installed service definition. */
  readonly serviceOrigin?: string
  readonly resourceOrigin?: string
  readonly serviceSettings?: NativeServiceSettingsHistory
}
export interface PluginInstallationsPort {
  get(spaceId: string): Promise<readonly PluginInstallation[]>
  save(spaceId: string, record: PluginInstallation): Promise<void>
  resetForSpace(spaceId: string): Promise<void>
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
