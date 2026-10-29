import type { SkillRepositories } from './skill-unit-of-work.js'
import type { ExpertReferenceMutationsPort, ExpertReferencesPort } from './experts.js'
import type { ContributionActors } from './contribution-unit-of-work.js'
import type { RuntimeDependencyStorePort, RuntimeDependencyReferencesPort } from './runtime-dependencies.js'
import type { ExecutionConfigurationStorePort } from './platform-execution.js'
import type { PluginLibraryStorePort } from './plugin-library.js'
import type { PluginAccessStorePort } from './plugin-access.js'
import type { PluginUpstreamsPort } from './plugin-upstreams.js'
import type { PluginGroupConfigurationPort } from './managed-plugins.js'
import type { PluginSelectionsPort } from './plugin-selections.js'
import type { CatalogInstallRows, CatalogRequestRows } from './catalog-records.js'
import type { PlatformUnitOfWorkPort } from './platform-unit-of-work.js'

export interface SuiteFactLocks {
  acquire(input: {
    readonly retiringChoices?: boolean
    readonly runtimeCommands: readonly string[]
    readonly executionCommands: readonly string[]
    readonly runtime: readonly string[]
    readonly skills: readonly string[]
    readonly packs: readonly string[]
    readonly plugins: readonly string[]
  }): Promise<void>
}

/** Prepared catalog changes bind every fact owner and their result to the same transaction. */
export interface SuiteRepositories extends SkillRepositories {
  readonly locks: SuiteFactLocks
  readonly accounts: ContributionActors
  readonly runtime: RuntimeDependencyStorePort
  readonly runtimeReferences: RuntimeDependencyReferencesPort
  readonly execution: ExecutionConfigurationStorePort
  readonly plugins: PluginLibraryStorePort
  readonly pluginAccess: PluginAccessStorePort
  readonly pluginUpstreams: PluginUpstreamsPort
  readonly pluginGrants: PluginGroupConfigurationPort
  readonly pluginSelections: PluginSelectionsPort
  readonly expertReferences: ExpertReferenceMutationsPort & ExpertReferencesPort
  readonly installs: CatalogInstallRows
  readonly requests: CatalogRequestRows
}
export type SuiteUnitOfWork = PlatformUnitOfWorkPort<SuiteRepositories>
