import type { Expert, ExpertState } from '../domain/expert.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'

export interface ExpertStorePort { version?(): number, read(): ExpertState, write(state: ExpertState): void }
export interface ExpertSkillsPort { skills(username: string): readonly LibrarySkill[] }
export interface ExpertPluginsPort { plugins(username: string): readonly PreparedPlugin[] }
export interface ExpertMcpPort { version?(): string | number | undefined, mcp(username: string): readonly string[] }
export interface ExpertMemberPlan {
  readonly expert: Expert
  readonly skills: readonly LibrarySkill[]
  readonly requestedSkills: readonly string[]
  readonly globalSkills: readonly string[]
  readonly failures: readonly string[]
}
export interface MemberExpertsPort { plans(username: string): readonly ExpertMemberPlan[] }

/** Reuses the protected execution forwarding for scripts in expert-only skill trees. */
export interface ExpertSkillProjectionPort { identity?(spaceId: string): unknown, apply(spaceId: string, directory: string): Promise<void> }
