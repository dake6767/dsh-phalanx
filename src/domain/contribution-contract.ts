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
export interface CommunityContributionReview extends CommunitySkillPreview {
  readonly execution?: CommunityExecutionView
  readonly plugin?: CommunityContributionPluginView
  readonly groups?: readonly CommunityContributionGroupView[]
}

export interface ContributionPluginDraft { readonly access: CommunityPluginAccessInput, readonly upstreams: readonly (CommunityPluginUpstreamInput & { readonly hasCredential: boolean })[] }
