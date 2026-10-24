import type { UploadedSkill } from './skill-library.js'
export const SKILL_IMPORT_MAX_BYTES = 100 * 1024 * 1024
/** Only catalog installation/update staging grants the larger Git intake profile. */
export type SkillImportPolicy = 'standard' | 'catalog'
export const CATALOG_SKILL_IMPORT_MAX_BYTES = 128 * 1024 * 1024
export const CATALOG_SKILL_MAX_BYTES = 64 * 1024 * 1024
export const CATALOG_SKILL_MAX_FILES = 16384
export interface SkillImportWarning { readonly path: string, readonly kind: 'filename' | 'content' }
export interface SkillImportCandidate extends UploadedSkill {
  readonly source?: import('./skill-git-source.js').SkillGitSource
  readonly path: string
  readonly internal: boolean
  readonly orchestration: boolean
  readonly warnings: readonly SkillImportWarning[]
}
export interface SkillImportSuggestion { readonly name: string, readonly description: string, readonly skills: readonly string[] }
export interface SkillImportCandidates {
  readonly candidates: readonly SkillImportCandidate[]
  readonly packs: readonly SkillImportSuggestion[]
}
