import type { CommunityAccountActor } from '../domain/community-account.js'
import type { ContributionSetup, ContributionDeclaration, ContributionUpload, MemberContribution } from '../domain/member-contribution.js'
import type {
  CommunitySkillGroupView,
  CommunityExecutionInput,
  CommunityExecutionView,
  CommunitySkillPreview,
  CommunitySkillView,
} from '../domain/admin-contract.js'
export interface ContributionSetupIdentity {
  readonly id: string
  readonly revision: string
}
export interface ContributionSetupStore {
  save(identity: ContributionSetupIdentity, setup: ContributionSetup): Promise<string>
  read(reference: string, identity: ContributionSetupIdentity): Promise<ContributionSetup | undefined>
  remove(reference: string): Promise<void>
}
export interface ContributionArtifacts {
  accept(content: AsyncIterable<Uint8Array>, signal: AbortSignal, declaration?: ContributionDeclaration, retainWarnings?: boolean): Promise<ContributionUpload>
  read(hash: string): Promise<Uint8Array>
  collect(retained: readonly string[]): Promise<void>
  newId(): string
}
export interface ContributionAdoption {
  synchronizeContribution?(): Promise<void>
  upload(actor: CommunityAccountActor, content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<CommunitySkillPreview>
  confirm(
    actor: CommunityAccountActor,
    token: string,
    revision: string,
    contribution?: {
      readonly id: string
      readonly revision: string
      readonly committed: () => void
      readonly commit?: (skill: import('../domain/skill-library.js').LibrarySkill) => Promise<void>
      readonly adoption?: import('../domain/library-contribution.js').LibraryContributionAdoption
    },
  ): Promise<CommunitySkillView>
  contributionDependencies?(
    actor: CommunityAccountActor,
    name: string,
    declaration: ContributionDeclaration,
  ): Promise<import('../domain/contribution-contract.js').CommunityContributionDependencies>
  validateContributionDependencies?(actor: CommunityAccountActor, row: MemberContribution, names: readonly string[]): Promise<void>
  contributionGroups?(actor: CommunityAccountActor): Promise<readonly CommunitySkillGroupView[]>
  validateContributionDistribution?(actor: CommunityAccountActor, setup?: ContributionSetup): Promise<void>
}

export interface ContributionMaintenancePort {
  start(cleanup: () => Promise<void>): () => void
}

export interface ContributionExecutionPort {
  contributionRevision?(name: string): Promise<string>
  checkContribution(name: string, declaration: ContributionDeclaration): Promise<void>
  contributionRemoved?(
    name: string,
    declaration: ContributionDeclaration,
  ): Promise<{ readonly commands: readonly string[]; readonly variables: readonly string[] }>
  contributionPreview(name: string, declaration: ContributionDeclaration): Promise<CommunityExecutionView>
  checkAdoption(row: MemberContribution, input?: CommunityExecutionInput, expectedRevision?: string): Promise<void>
  adoptContribution(row: MemberContribution, input?: CommunityExecutionInput, expectedRevision?: string): Promise<readonly string[]>
}

export interface ContributionCommandInventory {
  commands(signal: AbortSignal): Promise<readonly string[]>
}
