import type { SkillPack } from '../domain/skill-pack.js'
import type { UploadedSkill } from '../domain/skill-library.js'
import type { SkillAssignmentsPort, SkillAssignmentsView } from './member-skills.js'

export interface SkillPackView {
  list(): readonly SkillPack[]
}
export interface SkillPackStorePort {
  list(): Promise<readonly SkillPack[]>
  save(pack: SkillPack, expectedRevision?: number | 'none'): Promise<void>
  remove(name: string, expectedRevision?: number): Promise<void>
  rename?(previous: string, pack: SkillPack): Promise<void>
}
export interface SkillPackViews {
  readonly store: SkillPackView
  readonly grants: SkillAssignmentsView
  readonly selections: SkillAssignmentsView
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
