import type { LibraryPlugin, PluginCandidate, UploadedPlugin, PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityPluginStage } from '../domain/admin-contract.js'

export interface PluginLibraryStorePort {
  list(): readonly LibraryPlugin[]
  save(plugin: LibraryPlugin): void
}
export interface PluginPreparerPort {
  recover?(): Promise<void>
  prepare(input: PluginCandidate, progress: (stage: Exclude<CommunityPluginStage, 'available' | 'failed'>) => void, signal: AbortSignal): Promise<PreparedPlugin>
}

export interface PluginUploadPort {
  accept(filename: string, content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<UploadedPlugin>
  discard(archive: string): Promise<void>
  recover?(retainedArchives: readonly string[]): Promise<void>
}
export interface PluginArchiveInspectorPort {
  inspect(archive: string, signal: AbortSignal): Promise<{ readonly packageName: string, readonly version: string }>
}
