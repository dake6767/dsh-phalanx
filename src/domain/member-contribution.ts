import type { CommunityAccountActor } from './community-account.js'
import type { UploadedSkill } from './skill-library.js'

export interface ContributionDeclaration { readonly purpose: string }
export interface MemberContribution extends UploadedSkill {
  readonly revision: string
  readonly id: string
  readonly contributor: CommunityAccountActor
  readonly declaration: ContributionDeclaration
  readonly submittedAt: number
  readonly updatedAt: number
  readonly status: 'pending' | 'adopted' | 'declined' | 'withdrawn'
  readonly reason?: string
}
export type ContributionDecision = { readonly action: 'adopt', readonly revision: string, readonly token: string } | { readonly action: 'decline', readonly revision: string, readonly reason: string }
