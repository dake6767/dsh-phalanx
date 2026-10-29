import type { CommunityAccountActor } from '../domain/community-account.js'
import type { MemberContribution, ContributionSetup } from '../domain/member-contribution.js'
import type { LibraryPlugin } from '../domain/plugin-library.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { ContributionRecord } from './contribution-rows.js'

export interface ContributionTransactionsPort {
  replay(actor: CommunityAccountActor, record: ContributionRecord): Promise<void>
  submit(actor: CommunityAccountActor, row: MemberContribution): Promise<MemberContribution>
  withdraw(actor: CommunityAccountActor, record: ContributionRecord, updatedAt: number): Promise<void>
  decline(actor: CommunityAccountActor, record: ContributionRecord, reason: string, updatedAt: number): Promise<void>
  remove(record: ContributionRecord): Promise<void>
  plugin(
    actor: CommunityAccountActor,
    record: ContributionRecord,
    plugin: LibraryPlugin,
    setup: ContributionSetup | undefined,
    updatedAt: number,
    committed: () => void,
    impact: string,
  ): Promise<void>
  skill(
    actor: CommunityAccountActor,
    record: ContributionRecord,
    skill: LibrarySkill,
    setup: ContributionSetup | undefined,
    updatedAt: number,
    impact: string,
  ): Promise<void>
}
