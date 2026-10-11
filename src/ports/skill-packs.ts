import type { SkillPack } from '../domain/skill-pack.js'
import type { UploadedSkill } from '../domain/skill-library.js'
import type { SkillAssignmentsPort } from './member-skills.js'

export interface SkillPackStorePort {
  list(): readonly SkillPack[]
  save(pack: SkillPack): void
  remove(name: string): void
}
export interface SkillPackSources {
  readonly store: Pick<SkillPackStorePort, 'list'>
  readonly grants: Pick<SkillAssignmentsPort, 'get'>
  readonly selections: Pick<SkillAssignmentsPort, 'get'>
}
export interface SkillPackState extends SkillPackSources {
  readonly store: SkillPackStorePort
  readonly grants: SkillAssignmentsPort
  readonly selections: SkillAssignmentsPort
}
export interface SkillNotePort {
  createNote(name: string, description: string, instructions: string): Promise<UploadedSkill>
}
