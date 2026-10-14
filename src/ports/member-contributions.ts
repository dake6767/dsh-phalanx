import type { CommunityAccountActor } from '../domain/community-account.js'
import type { MemberContribution } from '../domain/member-contribution.js'
import type { CommunitySkillPreview, CommunitySkillView } from '../domain/admin-contract.js'
import type { UploadedSkill } from '../domain/skill-library.js'
export interface ContributionAdoptionIntent {
  readonly id: string
  readonly revision: string
  readonly actor: CommunityAccountActor
  readonly hash: string
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
  accept(content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<UploadedSkill>
  read(hash: string): Promise<Uint8Array>
  collect(retained: readonly string[]): Promise<void>
  newId(): string
}
export interface ContributionAdoption {
  upload(actor: CommunityAccountActor, content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<CommunitySkillPreview>
  confirm(actor: CommunityAccountActor, token: string, revision: string): Promise<CommunitySkillView>
  adopted(name: string, hash: string): boolean
}

export interface ContributionMaintenancePort { start(cleanup: () => Promise<void>): () => void }
