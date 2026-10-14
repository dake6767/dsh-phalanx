import type { PluginContributionArtifact } from '../domain/plugin-contribution.js'
export type { PluginContributionArtifact } from '../domain/plugin-contribution.js'
import type { ContributionSetup, ContributionDeclaration, ContributionUpload, MemberContribution } from '../domain/member-contribution.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityContributionReview, CommunityPluginUpstreamInput, CommunityPluginUpstreamTestResult, CommunitySkillPreview } from '../domain/admin-contract.js'

export type PluginContributionInput = { readonly source: 'npm', readonly packageName: string, readonly version: string }
  | { readonly source: 'upload', readonly filename: string, readonly content: AsyncIterable<Uint8Array> }
export interface PreparedPluginContribution extends ContributionUpload {
  readonly plugin: PluginContributionArtifact
  readonly keyFiles: readonly { readonly path: string, readonly content: string }[]
}
export interface PluginContributionPreparationPort {
  prepare(input: PluginContributionInput, signal: AbortSignal, declaration?: ContributionDeclaration, retainWarnings?: boolean): Promise<PreparedPluginContribution>
  publish(artifact: PluginContributionArtifact, commit: (promoted: PluginContributionArtifact, retained: () => void) => void): Promise<void>
  recover(retained: readonly PluginContributionArtifact[]): Promise<void>
}
export interface PluginContributionPort {
  accept(input: PluginContributionInput, signal: AbortSignal, declaration?: ContributionDeclaration, retainWarnings?: boolean): Promise<PreparedPluginContribution>
  review(actor: CommunityAccountActor, row: MemberContribution, token: string): CommunityContributionReview
  confirm(actor: CommunityAccountActor, row: MemberContribution, preview: CommunitySkillPreview, committed: () => void): Promise<void>
  validate?(actor: CommunityAccountActor, row: MemberContribution, setup?: ContributionSetup): void
  apply?(row: MemberContribution, setup?: ContributionSetup): Promise<readonly string[]>
  test?(actor: CommunityAccountActor, row: MemberContribution, input: CommunityPluginUpstreamInput): Promise<CommunityPluginUpstreamTestResult>
  adopted(row: MemberContribution): boolean
  collect(rows: readonly MemberContribution[]): Promise<void>
}
