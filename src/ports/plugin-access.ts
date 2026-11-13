import type { InstalledServices } from '../domain/installed-services.js'
import type { CatalogPluginServiceSlot } from '../domain/suite-service-slots.js'
import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import type { PluginAccessCheckpoint, PluginAccessSettings, PluginEntryConfig } from '../domain/plugin-access.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityModelGatewayAccess } from './community-runtime.js'
export interface PluginInstalledServices {
  readonly revision: string
  readonly configuration: InstalledServices<CatalogPluginServiceSlot>
}
export interface PluginAccessStorePort {
  installedServices?(packageName: string): Promise<PluginInstalledServices | undefined>
  installedServiceOwner?(packageName: string): Promise<string | undefined>
  saveInstalledServices?(
    packageName: string,
    origin: string | null,
    configuration: PluginInstalledServices['configuration'] | undefined,
    expectedRevision: string,
  ): Promise<string | void>
  get(packageName: string): PluginAccessSettings | undefined | Promise<PluginAccessSettings | undefined>
  list(): Readonly<Record<string, PluginAccessSettings>> | Promise<Readonly<Record<string, PluginAccessSettings>>>
  commitContribution?(packageName: string, settings: Omit<PluginAccessSettings, 'revision'> | undefined, contribution: ContributionReceipt): Promise<void>
  receipt?(packageName: string): ContributionReceipt | undefined | Promise<ContributionReceipt | undefined>
  save(packageName: string, settings: Omit<PluginAccessSettings, 'revision'>, contribution?: ContributionReceipt, expectedRevision?: string): Promise<void>
  remove(packageName: string, expectedRevision?: string): Promise<void>
  applySuite?(packageName: string, task: string, settings: Omit<PluginAccessSettings, 'revision'>): Promise<void>
  restoreSuite?(packageName: string, task: string): Promise<boolean>
  /** Catalog-task checkpoints; `undefined` clears the package's checkpoint. */
  suiteCheckpoint?(packageName: string): PluginAccessCheckpoint | undefined | Promise<PluginAccessCheckpoint | undefined>
  saveSuiteCheckpoint?(packageName: string, checkpoint: PluginAccessCheckpoint | undefined): Promise<void>
  /** Clears a settled or removed task's checkpoint; only the matching task may clear it. */
  clearSuiteCheckpoint?(packageName: string, task: string): Promise<void>
}
export interface PluginAccessSyntaxPort {
  parse(source: string): Readonly<Record<string, PluginEntryConfig>>
  entryIds(plugin: PreparedPlugin): readonly string[]
}
export interface MemberPluginAccessPort {
  snapshot(
    username: string,
    installed?: readonly string[],
    archives?: import('../domain/plugin-preinstall.js').NativePluginArchiveFacts,
  ): Promise<readonly string[]>
  resolve(
    plugins: readonly PreparedPlugin[],
    access: CommunityModelGatewayAccess,
    native?: {
      readonly username: string
      readonly installed: readonly string[]
      readonly preinstall?: readonly string[]
      readonly nativeResources?: import('../domain/plugin-preinstall.js').NativePluginDependencyPlans
      readonly dependencyVersions?: Readonly<Record<string, import('../domain/runtime-dependency.js').RuntimeDependencyVersion>>
    },
  ): Promise<{
    readonly environment: Readonly<Record<string, string>>
    readonly entries: Readonly<Record<string, Readonly<Record<string, PluginEntryConfig>>>>
    readonly snapshot: readonly string[]
    readonly nativeFailures?: readonly string[]
  }>
}
