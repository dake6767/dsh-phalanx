import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { LibrarySkill } from '../domain/skill-library.js'

export interface EffectiveSkill {
  readonly skill: LibrarySkill
  readonly source: 'managed' | 'selected'
}
/** Published assignments used only by synchronous member expansion. */
export interface SkillAssignmentsView {
  get(id: string): readonly string[]
}
export interface SkillAssignmentsPort {
  contributionReceipt?(id: string, name: string): Promise<import('../domain/contribution-receipt.js').ContributionReceipt | undefined>
  grantContribution?(id: string, name: string, receipt: import('../domain/contribution-receipt.js').ContributionReceipt): Promise<void>
  get(id: string): Promise<readonly string[]>
  set(id: string, names: readonly string[]): Promise<void>
  retain(ids: readonly string[], names: readonly string[]): Promise<void>
}
/** Reconciles the desired projection, including removal of retired member directories. */
export interface SkillDistributionPort {
  snapshot?(
    members: readonly {
      readonly spaceId: string
      readonly skills: readonly LibrarySkill[]
      readonly runtimeDependencies?: readonly RuntimeDependencyVersion[]
    }[],
  ): Promise<{ inputs: unknown; outputs: unknown }>
  synchronize(
    members: readonly {
      readonly spaceId: string
      readonly skills: readonly LibrarySkill[]
      readonly runtimeDependencies?: readonly RuntimeDependencyVersion[]
    }[],
  ): Promise<void>
}
export interface MemberSkillsPort {
  prepare(username: string, dependencies?: readonly RuntimeDependencyVersion[]): Promise<void>
}

/** Read-only top-level names in the member's own default skill roots. */
export interface MemberSkillNamesPort {
  names(username: string): Promise<readonly string[]>
}
