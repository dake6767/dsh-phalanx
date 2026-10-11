import type { LibrarySkill } from './skill-library.js'

export interface SkillPack {
  readonly renamedFrom?: string
  readonly removing?: readonly string[]
  readonly name: string
  readonly description: string
  readonly skills: readonly string[]
  readonly instructions: string
  readonly published: boolean
  readonly note?: LibrarySkill
}
