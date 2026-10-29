import type { CommunityAccountActor } from '../domain/community-account.js'
import type { MemberContribution } from '../domain/member-contribution.js'
import type { ContributionMaintenanceReview } from '../domain/library-contribution.js'
export interface ContributionPolicyPort {
  check(kind: 'skill' | 'plugin', actor: CommunityAccountActor, name: string, version?: string): Promise<void>
  review(row: MemberContribution): Promise<ContributionMaintenanceReview>
}

export interface ContributionPluginFilesPort {
  files(prepared: import('../domain/plugin-library.js').PreparedPlugin): Promise<Readonly<Record<string, string>>>
}
