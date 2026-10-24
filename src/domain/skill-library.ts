import { BusinessRuleError } from './business-error.js'
export const SKILL_MAX_BYTES = 20 * 1024 * 1024
export type SkillArchiveCode = 'skill-archive-invalid' | 'skill-upload-too-large' | 'skill-catalog-limit-exceeded' | 'skill-frontmatter-invalid' | 'skill-builtin-conflict'
export class SkillArchiveError extends BusinessRuleError {
  constructor(code: SkillArchiveCode, reason: string) { super('invalid', reason, code, { reason }) }
}

export interface LibrarySkill {
  readonly runtimeDependencies?: readonly string[]
  readonly contributionPublicationReceipt?: import('./contribution-receipt.js').ContributionReceipt
  readonly contributionDistributionReceipt?: import('./contribution-receipt.js').ContributionReceipt
  readonly provenance?: import('./library-contribution.js').LibraryProvenance
  readonly contributionReceipt?: { readonly id: string, readonly revision: string }
  readonly source?: import('./skill-git-source.js').SkillGitSource
  readonly suiteOrigin?: string
  readonly name: string
  readonly description: string
  readonly hash: string
  readonly importedAt: number
  readonly published: boolean
  readonly conflict?: boolean
}
export interface SkillContents {
  readonly fileHashes?: Readonly<Record<string, string>>
  readonly markdown: string
  readonly files: readonly string[]
}
export interface UploadedSkill extends SkillContents {
  readonly name: string
  readonly description: string
  readonly hash: string
}
