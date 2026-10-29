import type { LibrarySkill } from './skill-library.js'

export interface SkillPack {
  readonly rowRevision?: number
  readonly suiteOrigin?: string
  readonly name: string
  readonly description: string
  readonly skills: readonly string[]
  readonly instructions: string
  readonly published: boolean
  readonly note?: LibrarySkill
}

export function assertSkillPackRow(row: SkillPack): void {
  if (
    !row ||
    typeof row.name !== 'string' ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.name) ||
    typeof row.description !== 'string' ||
    !row.description.length ||
    typeof row.instructions !== 'string' ||
    typeof row.published !== 'boolean' ||
    !Array.isArray(row.skills) ||
    row.skills.some(name => typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)) ||
    (row.suiteOrigin !== undefined && (typeof row.suiteOrigin !== 'string' || !row.suiteOrigin.startsWith('suite:'))) ||
    (row.note &&
      (row.note.name !== row.name ||
        !/^[a-f0-9]{64}$/u.test(row.note.hash) ||
        typeof row.note.description !== 'string' ||
        !Number.isFinite(row.note.importedAt)))
  )
    throw new Error('Invalid skill pack record')
}
