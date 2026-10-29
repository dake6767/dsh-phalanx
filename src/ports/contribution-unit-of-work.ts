import type { ExpertReferencesPort, ExpertReferenceMutationsPort } from './experts.js'
import type { ExpertReferenceTarget, ExpertReferenceImpact } from '../domain/expert-reference.js'
import type { PluginLibraryStorePort } from './plugin-library.js'
import type { PluginGroupConfigurationPort } from './managed-plugins.js'
import type { PluginSelectionsPort } from './plugin-selections.js'
import type { PluginAccessStorePort } from './plugin-access.js'
import type { PluginUpstreamsPort } from './plugin-upstreams.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityAccountStorePort } from './community-accounts.js'
import type { ContributionRows } from './contribution-rows.js'
import type { ExecutionConfigurationStorePort } from './platform-execution.js'
import type { RuntimeDependencyStorePort } from './runtime-dependencies.js'
import type { SkillRepositories } from './skill-unit-of-work.js'
import type { PlatformUnitOfWorkPort } from './platform-unit-of-work.js'

export interface ContributionActors extends Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'> {
  lockDirectory(): Promise<void>
  lockMember(actor: CommunityAccountActor): Promise<void>
  lock(actor: CommunityAccountActor, contributor: CommunityAccountActor, groups: readonly string[], related?: readonly CommunityAccountActor[]): Promise<void>
}
export interface ContributionRepositories extends SkillRepositories {
  readonly expertReferences: ExpertReferencesPort &
    ExpertReferenceMutationsPort & {
      lockImpact(targets: readonly ExpertReferenceTarget[]): Promise<ExpertReferenceImpact>
    }
  readonly skillImpact: { lock(name: string, retireSelections?: boolean): Promise<void> }
  readonly submission: { check(actor: CommunityAccountActor, row: import('../domain/member-contribution.js').MemberContribution): Promise<void> }
  readonly accounts: ContributionActors
  readonly contributions: ContributionRows
  readonly execution: ExecutionConfigurationStorePort
  readonly plugins: PluginLibraryStorePort & { lock(packageName: string, revision: number | 'none'): Promise<void> }
  readonly pluginGrants: PluginGroupConfigurationPort
  readonly pluginSelections: PluginSelectionsPort
  readonly pluginAccess: PluginAccessStorePort
  readonly pluginUpstreams: PluginUpstreamsPort & { lock(packageName: string): Promise<void> }
  readonly runtime: RuntimeDependencyStorePort
}
export type ContributionUnitOfWork = PlatformUnitOfWorkPort<ContributionRepositories>
