import type { PlatformUnitOfWorkPort } from './platform-unit-of-work.js'
import type { SkillLibraryStorePort } from './skill-library.js'
import type { SkillPackState } from './skill-packs.js'
import type { SkillAssignmentsPort } from './member-skills.js'
import type { ExpertReferenceMutationsPort } from './experts.js'

/** The skill mutation owns one transaction across library, pack membership and assignment facts. */
export interface SkillRepositories {
  readonly library: SkillLibraryStorePort
  readonly packs: SkillPackState
  readonly grants: SkillAssignmentsPort
  readonly selections: SkillAssignmentsPort
  readonly expertReferences?: ExpertReferenceMutationsPort
}
export type SkillUnitOfWork = PlatformUnitOfWorkPort<SkillRepositories>
