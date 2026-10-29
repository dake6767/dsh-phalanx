import type { LibrarySkill } from './skill-library.js'
import type { SkillPack } from './skill-pack.js'
import { libraryProvenanceRevision } from './library-contribution.js'

export interface SkillImpactMember {
  readonly spaceId: string
  readonly groupId: string
  readonly disabled: boolean
  readonly granted: boolean
  readonly selected: boolean
  readonly packGrants: readonly string[] | undefined
  readonly packSelections: readonly string[] | undefined
}
export function skillMembershipRevision(members: readonly SkillImpactMember[]): unknown {
  return members.map(row => [row.spaceId, row.groupId, row.disabled, row.granted, row.selected, row.packGrants, row.packSelections]).sort()
}
/** Preserve the existing preview token, including all package choices of each account. */
export function skillImpactRevision(
  row: LibrarySkill | undefined,
  membership: unknown,
  packs: readonly SkillPack[] | undefined,
  name: string,
  expertRevision: string | undefined,
): string {
  return JSON.stringify([
    row ? { ...row, ...(row.provenance ? { provenance: libraryProvenanceRevision(row.provenance) } : {}) } : null,
    membership,
    packs?.filter(pack => pack.skills.includes(name) || pack.note?.name === name),
    expertRevision,
  ])
}
