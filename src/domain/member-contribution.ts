import type { CommunityExecutionInput } from './admin-contract.js'
import type { CommunityAccountActor } from './community-account.js'
import type { UploadedSkill } from './skill-library.js'

export interface RequiredContributionCommand {
  readonly name: string
  readonly purpose: string
  readonly installation: string
}
export interface ContributionDeclaration {
  readonly purpose: string
  readonly requiredCommands?: readonly RequiredContributionCommand[]
  readonly plugin?: import('./plugin-contribution-checks.js').PluginContributionDeclaration
  readonly execution?: {
    readonly commands: readonly { readonly command: string; readonly blocked: readonly string[] }[]
    readonly variables: readonly { readonly name: string; readonly purpose: string; readonly application: string }[]
  }
}
export interface ContributionFinding {
  readonly code:
    | 'contribution-plugin-reserved'
    | 'contribution-plugin-entry'
    | 'contribution-plugin-reference'
    | 'contribution-plugin-access'
    | 'contribution-plugin-upstream-unused'
    | 'contribution-plugin-install-script'
    | 'contribution-plugin-domain'
    | 'contribution-private-key'
    | 'contribution-credential-high'
    | 'contribution-credential-low'
    | 'contribution-excluded-file'
    | 'contribution-large'
    | 'contribution-command-undeclared'
  readonly severity: 'reject' | 'warning'
  readonly path?: string
  readonly advice: string
}
export interface ContributionUpload extends UploadedSkill {
  readonly findings?: readonly ContributionFinding[]
}
export interface MemberContribution extends UploadedSkill {
  readonly kind?: 'skill' | 'plugin'
  readonly plugin?: import('./plugin-contribution.js').PluginContributionArtifact
  readonly keyFiles?: readonly { readonly path: string; readonly content: string }[]
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
export interface ContributionConfigurationRevision {
  readonly access?: string
  readonly upstreams?: string
  readonly execution?: string
}
export interface ContributionSetup {
  readonly runtimeDependencies?: readonly string[]
  readonly configuration?: ContributionConfigurationRevision
  readonly maintenance?: import('./library-contribution.js').ContributionMaintenance
  readonly credentialSharingConfirmed?: boolean
  readonly plugin?: {
    readonly access: import('./admin-contract.js').CommunityPluginAccessInput
    readonly upstreams: readonly import('./admin-contract.js').CommunityPluginUpstreamInput[]
  }
  readonly execution?: CommunityExecutionInput
  readonly published?: boolean
  readonly groups?: readonly { readonly id: string; readonly revision: string }[]
}
export type ContributionDecision =
  | { readonly action: 'adopt'; readonly revision: string; readonly token: string; readonly setup?: ContributionSetup }
  | { readonly action: 'decline'; readonly revision: string; readonly reason: string }
