import type { CommunityAccountActor } from '../domain/community-account.js'
import type { ContributionSetup, MemberContribution } from '../domain/member-contribution.js'
import type {
  CommunityContributionGroupView,
  CommunityContributionPluginView,
  CommunityPluginUpstreamInput,
  CommunityPluginUpstreamTestResult,
} from '../domain/admin-contract.js'
export interface PluginContributionAdministrationPort {
  preview(
    actor: CommunityAccountActor,
    row: MemberContribution,
  ): Promise<{
    readonly plugin: CommunityContributionPluginView
    readonly groups?: readonly CommunityContributionGroupView[]
    readonly configuration?: import('../domain/member-contribution.js').ContributionConfigurationRevision
  }>
  validate(actor: CommunityAccountActor, row: MemberContribution, setup?: ContributionSetup): Promise<void>
  apply(row: MemberContribution, setup?: ContributionSetup): Promise<readonly string[]>
  test?(actor: CommunityAccountActor, row: MemberContribution, input: CommunityPluginUpstreamInput): Promise<CommunityPluginUpstreamTestResult>
}
export interface PluginContributionDistributionPort {
  groups(actor: CommunityAccountActor, packageName: string): Promise<readonly CommunityContributionGroupView[]>
  validate(actor: CommunityAccountActor, packageName: string, setup?: ContributionSetup): Promise<void>
  apply(row: MemberContribution, setup?: ContributionSetup): Promise<readonly string[]>
}
