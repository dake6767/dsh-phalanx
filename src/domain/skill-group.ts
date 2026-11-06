import type { CommunitySkillGroupView } from './admin-contract.js'
import type { CommunityAccountRecord } from './community-account.js'
import type { CommunityGroupRecord } from './community-group.js'
import type { LibrarySkill } from './skill-library.js'
import type { SkillPack } from './skill-pack.js'
import { skillListPresentation } from './skill-list-presentation.js'
import { libraryProvenanceRevision } from './library-contribution.js'

/** The same confirmed group facts are used by ordinary management and an atomic adoption. */
export function skillGroupView({
  group,
  library,
  packs,
  packGrants,
  granted,
  accounts,
  directNames,
}: {
  directNames: readonly string[]
  group: CommunityGroupRecord
  library: readonly LibrarySkill[]
  packs: readonly SkillPack[] | undefined
  packGrants: readonly string[] | undefined
  granted: ReadonlySet<string>
  accounts: readonly CommunityAccountRecord[]
}): CommunitySkillGroupView {
  const id = group.id,
    presentation = skillListPresentation(packs ?? [], directNames)
  return {
    group,
    skills: library.map(skill => ({
      name: skill.name,
      topLevel: presentation.get(skill.name)?.topLevel ?? true,
      description: skill.description,
      conflict: !!skill.conflict,
      granted: granted.has(skill.name),
    })),
    packs:
      packs?.map(pack => ({
        name: pack.name,
        skills: pack.skills,
        description: pack.description,
        granted: !!packGrants?.includes(pack.name),
        empty: !pack.skills.length,
      })) ?? [],
    members: accounts.filter(account => account.groupId === id).length,
    revision: JSON.stringify([
      library.map(row => ({ ...row, ...(row.provenance ? { provenance: libraryProvenanceRevision(row.provenance) } : {}) })),
      packs,
      packGrants,
      [...granted].sort(),
      accounts.map(account => [account.spaceId, account.groupId, account.disabled]).sort(),
    ]),
  }
}
