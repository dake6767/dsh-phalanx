import type { LibrarySkill } from './skill-library.js'

export interface SkillPackDisplay {
  readonly displayName?: string
  readonly description?: string
}

export interface SkillPack {
  readonly rowRevision?: number
  readonly suiteOrigin?: string
  readonly name: string
  readonly description: string
  readonly catalogDisplayName?: string
  readonly displayOverrides?: SkillPackDisplay
  readonly skills: readonly string[]
  readonly instructions: string
  readonly published: boolean
  readonly note?: LibrarySkill
}

export function skillPackDisplay(pack: SkillPack) {
  const displayName = pack.displayOverrides?.displayName ?? pack.catalogDisplayName
  return { ...(displayName === undefined ? {} : { displayName }), description: pack.displayOverrides?.description ?? pack.description }
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
