import type { CommunityAccountActor } from '../domain/community-account.js'
import type { ContributionSetup, ContributionDeclaration, ContributionUpload, MemberContribution } from '../domain/member-contribution.js'
import type { CommunitySkillGroupView, CommunityExecutionInput, CommunityExecutionView, CommunitySkillPreview, CommunitySkillView } from '../domain/admin-contract.js'
export interface ContributionAdoptionIntent {
  readonly id: string
  readonly revision: string
  readonly actor: CommunityAccountActor
  readonly hash: string
  readonly setup?: ContributionSetup
  readonly confirmed?: boolean
}
export interface ContributionStore {
  intent(): ContributionAdoptionIntent | undefined
  begin(intent: ContributionAdoptionIntent): void
  finish(rows: readonly MemberContribution[]): void
  list(): readonly MemberContribution[]
  save(row: MemberContribution): void
  remove(id: string): void
}
export interface ContributionArtifacts {
  accept(content: AsyncIterable<Uint8Array>, signal: AbortSignal, declaration?: ContributionDeclaration, retainWarnings?: boolean): Promise<ContributionUpload>
  read(hash: string): Promise<Uint8Array>
  collect(retained: readonly string[]): Promise<void>
  newId(): string
}
export interface ContributionAdoption {
  upload(actor: CommunityAccountActor, content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<CommunitySkillPreview>
  confirm(actor: CommunityAccountActor, token: string, revision: string, contribution?: { readonly id: string, readonly revision: string, readonly committed: () => void, readonly adoption?: import('../domain/library-contribution.js').LibraryContributionAdoption }): Promise<CommunitySkillView>
  contributionGroups?(actor: CommunityAccountActor): readonly CommunitySkillGroupView[]
  validateContributionDistribution?(actor: CommunityAccountActor, setup?: ContributionSetup): void
  distributeContribution?(row: MemberContribution, setup?: ContributionSetup): Promise<readonly string[]>
  adopted(name: string, hash: string, receipt?: import('../domain/contribution-receipt.js').ContributionReceipt): boolean
}

export interface ContributionMaintenancePort { start(cleanup: () => Promise<void>): () => void }

export interface ContributionExecutionPort {
  contributionRevision?(name: string): string
  checkContribution(name: string, declaration: ContributionDeclaration): void
  contributionRemoved?(name: string, declaration: ContributionDeclaration): { readonly commands: readonly string[], readonly variables: readonly string[] }
  contributionPreview(name: string, declaration: ContributionDeclaration): CommunityExecutionView
  checkAdoption(row: MemberContribution, input?: CommunityExecutionInput, expectedRevision?: string): void
  adoptContribution(row: MemberContribution, input?: CommunityExecutionInput, expectedRevision?: string): Promise<readonly string[]>
}
