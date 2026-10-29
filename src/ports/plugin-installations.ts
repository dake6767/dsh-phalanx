/** Successful deliveries are history, independently of the current native inventory. */
export interface PluginInstallation {
  readonly packageName: string
  readonly source: 'selected' | 'preinstall'
  readonly version: string
}
export interface PluginInstallationsPort {
  get(spaceId: string): Promise<readonly PluginInstallation[]>
  save(spaceId: string, record: PluginInstallation): Promise<void>
  clearPreinstalls(spaceId: string): Promise<void>
}
