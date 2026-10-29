import type { LibraryPlugin, PluginCandidate, UploadedPlugin, PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityPluginStage } from '../domain/admin-contract.js'

export interface PluginLibraryStorePort {
  list(): Promise<readonly LibraryPlugin[]>
  save(plugin: LibraryPlugin, expectedRevision?: number | 'none'): Promise<void>
  remove(packageName: string, expectedRevision?: number): Promise<void>
}
export interface PluginPreparerPort {
  recover?(): Promise<void>
  prepare(
    input: PluginCandidate,
    progress: (stage: Exclude<CommunityPluginStage, 'available' | 'failed'>) => Promise<void>,
    signal: AbortSignal,
  ): Promise<PreparedPlugin>
}

export interface PluginUploadPort {
  accept(filename: string, content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<UploadedPlugin>
  discard(archive: string): Promise<void>
  recover?(retainedArchives: readonly string[]): Promise<void>
}
export interface PluginArchiveInspectorPort {
  inspect(archive: string, signal: AbortSignal): Promise<{ readonly packageName: string; readonly version: string }>
}

export interface PluginLibraryMembershipPort {
  impact(packageName: string): Promise<{ readonly groups: number; readonly members: number; readonly selectedMembers?: number }>
  /** The affected groups named, for catalog uninstall previews. */
  impactGroups?(packageName: string): Promise<readonly { readonly id: string; readonly name: string }[]>
  revoke(packageName: string): Promise<void>
}

/** Local invalidation token for synchronous credential registration; reads still use the store. */
export interface PluginAuthorizationViewPort {
  authorizationRevision(): string
}

export interface PluginRemovalRepositories {
  readonly library: Pick<PluginLibraryStorePort, 'remove'>
  readonly expertReferences?: import('./experts.js').ExpertReferenceMutationsPort
}
