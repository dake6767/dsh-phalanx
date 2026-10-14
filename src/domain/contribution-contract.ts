/** Member contribution management wire contract, re-exported by admin-contract. */
import type { CommunityGroupView, CommunityPluginAccessInput, CommunityPluginUpstreamView, CommunityPluginUpstreamInput, CommunitySkillPreview, CommunityExecutionView } from './admin-contract.js'
export interface CommunityContributionsView { readonly contributions: readonly import('./member-contribution.js').MemberContribution[] }

export interface CommunityContributionCounts { readonly skills: number, readonly plugins: number }

export interface CommunityContributionGroupView { readonly group: CommunityGroupView, readonly members: number, readonly revision: string, readonly granted: boolean }
export interface CommunityContributionPluginView {
  readonly access: CommunityPluginAccessInput
  readonly upstreams: readonly CommunityPluginUpstreamView[]
  readonly removed: { readonly environment: readonly string[], readonly entries: readonly string[], readonly upstreams: readonly string[] }
}
export interface CommunityContributionDependencies {
  readonly references: readonly string[]
  readonly requirements: readonly (import('./member-contribution.js').RequiredContributionCommand & { readonly dependency?: string, readonly added: boolean })[]
  readonly removed: readonly string[]
}
export interface CommunityContributionReview extends CommunitySkillPreview {
  readonly configuration?: import('./member-contribution.js').ContributionConfigurationRevision
  readonly maintenance?: import('./library-contribution.js').ContributionMaintenanceReview
  readonly dependencies?: CommunityContributionDependencies
  readonly executionRemoved?: { readonly commands: readonly string[], readonly variables: readonly string[] }
  readonly execution?: CommunityExecutionView
  readonly plugin?: CommunityContributionPluginView
  readonly groups?: readonly CommunityContributionGroupView[]
}

export interface ContributionPluginDraft { readonly access: CommunityPluginAccessInput, readonly upstreams: readonly (CommunityPluginUpstreamInput & { readonly hasCredential: boolean })[] }

export interface CommunityPluginContributionInfo { readonly contribution?: { readonly name?: string, readonly anonymous: boolean }, readonly canMaintain: boolean, readonly localCopy?: { readonly enabled: boolean, readonly application?: 'restart-required' | 'applied' } }
export interface CommunityLibraryMaintainerInput { readonly username: string | null, readonly revision: string }

export interface CommunityContributionInspection { readonly maintenance?: import('./library-contribution.js').ContributionMaintenanceReview }
