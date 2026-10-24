import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import type { PluginAccessCheckpoint, PluginAccessSettings, PluginEntryConfig } from '../domain/plugin-access.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityModelGatewayAccess } from './community-runtime.js'
export interface PluginAccessStorePort {
  get(packageName: string): PluginAccessSettings | undefined
  list(): Readonly<Record<string, PluginAccessSettings>>
  commitContribution?(packageName: string, settings: Omit<PluginAccessSettings, 'revision'> | undefined, contribution: ContributionReceipt): void
  receipt?(packageName: string): ContributionReceipt | undefined
  save(packageName: string, settings: Omit<PluginAccessSettings, 'revision'>, contribution?: ContributionReceipt): void
  remove(packageName: string): void
  applySuite?(packageName: string, task: string, settings: Omit<PluginAccessSettings, 'revision'>): void
  restoreSuite?(packageName: string, task: string): boolean
  /** Catalog-task checkpoints; `undefined` clears the package's checkpoint. */
  suiteCheckpoint?(packageName: string): PluginAccessCheckpoint | undefined
  saveSuiteCheckpoint?(packageName: string, checkpoint: PluginAccessCheckpoint | undefined): void
  /** Clears a settled or removed task's checkpoint; only the matching task may clear it. */
  clearSuiteCheckpoint?(packageName: string, task: string): void
}
export interface PluginAccessSyntaxPort {
  parse(source: string): Readonly<Record<string, PluginEntryConfig>>
  entryIds(plugin: PreparedPlugin): readonly string[]
}
export interface MemberPluginAccessPort {
  snapshot(username: string, installed?: readonly string[]): readonly string[]
  resolve(plugins: readonly PreparedPlugin[], access: CommunityModelGatewayAccess, native?: { readonly username: string, readonly installed: readonly string[], readonly dependencyVersions?: Readonly<Record<string, import('../domain/runtime-dependency.js').RuntimeDependencyVersion>> }): {
    readonly environment: Readonly<Record<string, string>>
    readonly entries: Readonly<Record<string, Readonly<Record<string, PluginEntryConfig>>>>
    readonly snapshot: readonly string[]
  }
}
