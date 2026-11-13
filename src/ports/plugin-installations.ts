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

export type NativeServiceSettingsHistory = Readonly<
  Record<
    string,
    {
      readonly contract: string
      readonly applied: string | null
      readonly pending?: string
    }
  >
>

export interface PluginServiceSettingsHistoryPort {
  replaceServiceSettings(spaceId: string, expected: PluginInstallation, next: NativeServiceSettingsHistory): Promise<boolean>
}
