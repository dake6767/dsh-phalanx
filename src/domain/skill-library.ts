import { BusinessRuleError } from './business-error.js'
export const SKILL_MAX_BYTES = 20 * 1024 * 1024
export type SkillArchiveCode = 'skill-archive-invalid' | 'skill-upload-too-large' | 'skill-frontmatter-invalid' | 'skill-builtin-conflict'
export class SkillArchiveError extends BusinessRuleError {
  constructor(code: SkillArchiveCode, reason: string) { super('invalid', reason, code, { reason }) }
}

export interface LibrarySkill {
  readonly name: string
  readonly description: string
  readonly hash: string
  readonly importedAt: number
  readonly published: boolean
  readonly conflict?: boolean
}
export interface SkillContents {
  readonly markdown: string
  readonly files: readonly string[]
}
export interface UploadedSkill extends SkillContents {
  readonly name: string
  readonly description: string
  readonly hash: string
}
