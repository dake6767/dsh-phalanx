import type { PlatformSearchSettingsChange, PlatformSearchSettingsView } from '../domain/admin-contract.js'

export interface PlatformSearchSettingsStore {
  view(): Promise<PlatformSearchSettingsView>
  save(change: PlatformSearchSettingsChange): Promise<PlatformSearchSettingsView>
  credential(): Promise<string | undefined>
}
