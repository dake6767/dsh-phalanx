import type { LibrarySkill } from '../domain/skill-library.js'

export interface EffectiveSkill { readonly skill: LibrarySkill, readonly source: 'managed' | 'selected' }
export interface SkillAssignmentsPort {
  get(id: string): readonly string[]
  set(id: string, names: readonly string[]): void
  retain(ids: readonly string[], names: readonly string[]): void
}
/** Reconciles the desired projection, including removal of retired member directories. */
export interface SkillDistributionPort {
  synchronize(members: readonly { readonly spaceId: string, readonly skills: readonly LibrarySkill[] }[]): Promise<void>
}
export interface MemberSkillsPort { prepare(username: string): Promise<void> }
