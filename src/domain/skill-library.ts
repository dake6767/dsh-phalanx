import { BusinessRuleError } from './business-error.js'
export const SKILL_MAX_BYTES = 20 * 1024 * 1024
export type SkillArchiveCode =
  'skill-archive-invalid' | 'skill-upload-too-large' | 'skill-catalog-limit-exceeded' | 'skill-frontmatter-invalid' | 'skill-builtin-conflict'
export class SkillArchiveError extends BusinessRuleError {
  constructor(code: SkillArchiveCode, reason: string) {
    super('invalid', reason, code, { reason })
  }
}

export interface LibrarySkill {
  /** Optimistic revision of the persisted library row; management views omit it. */
  readonly rowRevision?: number
  readonly runtimeDependencies?: readonly string[]
  readonly contributionPublicationReceipt?: import('./contribution-receipt.js').ContributionReceipt
  readonly contributionDistributionReceipt?: import('./contribution-receipt.js').ContributionReceipt
  readonly provenance?: import('./library-contribution.js').LibraryProvenance
  readonly contributionReceipt?: { readonly id: string; readonly revision: string }
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

export function assertLibrarySkillRow(row: LibrarySkill): void {
  if (
    !row ||
    typeof row.name !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.name) ||
    typeof row.description !== 'string' ||
    !row.description.length ||
    !/^[a-f0-9]{64}$/u.test(row.hash) ||
    !Number.isFinite(row.importedAt) ||
    typeof row.published !== 'boolean' ||
    (row.conflict !== undefined && typeof row.conflict !== 'boolean')
  )
    throw new Error('Invalid skill library record')
  if (
    row.runtimeDependencies !== undefined &&
    (!Array.isArray(row.runtimeDependencies) ||
      row.runtimeDependencies.some(name => typeof name !== 'string') ||
      new Set(row.runtimeDependencies).size !== row.runtimeDependencies.length)
  )
    throw new Error('Invalid skill runtime dependency references')
  if (row.suiteOrigin !== undefined && (typeof row.suiteOrigin !== 'string' || !row.suiteOrigin.startsWith('suite:')))
    throw new Error('Invalid skill suite origin')
}
