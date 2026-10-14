import type { CommunityExecutionInput } from './admin-contract.js'
import type { CommunityAccountActor } from './community-account.js'
import type { UploadedSkill } from './skill-library.js'

export interface ContributionDeclaration {
  readonly purpose: string
  readonly execution?: { readonly commands: readonly { readonly command: string, readonly blocked: readonly string[] }[], readonly variables: readonly { readonly name: string, readonly purpose: string, readonly application: string }[], readonly prepare?: string }
}
export interface ContributionFinding {
  readonly code: 'contribution-private-key' | 'contribution-credential-high' | 'contribution-credential-low' | 'contribution-excluded-file' | 'contribution-large' | 'contribution-prepare-mismatch'
  readonly severity: 'reject' | 'warning'
  readonly path?: string
  readonly advice: string
}
export interface ContributionUpload extends UploadedSkill { readonly findings?: readonly ContributionFinding[] }
export interface MemberContribution extends UploadedSkill {
  readonly kind?: 'skill' | 'plugin'
  readonly plugin?: import('./plugin-contribution.js').PluginContributionArtifact
  readonly keyFiles?: readonly { readonly path: string, readonly content: string }[]
  readonly revision: string
  readonly id: string
  readonly contributor: CommunityAccountActor
  readonly declaration: ContributionDeclaration
  readonly submittedAt: number
  readonly updatedAt: number
  readonly status: 'pending' | 'adopted' | 'declined' | 'withdrawn'
  readonly findings?: readonly ContributionFinding[]
  readonly retainedWarnings?: boolean
  readonly reason?: string
}
export interface ContributionSetup { readonly execution?: CommunityExecutionInput, readonly published?: boolean, readonly groups?: readonly { readonly id: string, readonly revision: string }[] }
export type ContributionDecision = { readonly action: 'adopt', readonly revision: string, readonly token: string, readonly setup?: ContributionSetup } | { readonly action: 'decline', readonly revision: string, readonly reason: string }
