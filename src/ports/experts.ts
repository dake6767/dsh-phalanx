import type { Expert, ExpertState } from '../domain/expert.js'
import type { LibrarySkill } from '../domain/skill-library.js'

export interface ExpertStorePort { read(): ExpertState, write(state: ExpertState): void }
export interface ExpertSkillsPort { skills(username: string): readonly LibrarySkill[] }
export interface ExpertMemberPlan {
  readonly expert: Expert
  readonly skills: readonly LibrarySkill[]
  readonly requestedSkills: readonly string[]
  readonly globalSkills: readonly string[]
  readonly failures: readonly string[]
}
export interface MemberExpertsPort { plans(username: string): readonly ExpertMemberPlan[] }

/** Reuses the protected execution forwarding for scripts in expert-only skill trees. */
export interface ExpertSkillProjectionPort { apply(spaceId: string, directory: string): Promise<void> }
