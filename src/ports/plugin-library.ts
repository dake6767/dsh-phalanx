import type { LibraryPlugin, PluginIdentity, PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityPluginStage } from '../domain/admin-contract.js'

export interface PluginLibraryStorePort {
  list(): readonly LibraryPlugin[]
  save(plugin: LibraryPlugin): void
}
export interface PluginPreparerPort {
  recover?(): Promise<void>
  prepare(input: PluginIdentity, progress: (stage: Exclude<CommunityPluginStage, 'available' | 'failed'>) => void, signal: AbortSignal): Promise<PreparedPlugin>
}
