import type { SkillPackSources } from '../ports/skill-packs.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { EffectiveSkill, SkillAssignmentsPort } from '../ports/member-skills.js'

/** The shared eligibility policy for readonly distribution and market state. */
export class MemberEffectiveSkills {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'listGroups'>,
    private readonly library: Pick<SkillLibraryStorePort, 'list'>, private readonly grants: Pick<SkillAssignmentsPort, 'get'>,
    private readonly selections?: Pick<SkillAssignmentsPort, 'get'>, private readonly packs?: SkillPackSources) {}
  effective(username: string): readonly EffectiveSkill[] {
    const account = this.accounts.get(username)
    if (!account || account.disabled) return []
    const group = this.accounts.listGroups().find(group => group.id === account.groupId)
    if (!group) return []
    const granted = new Set(this.grants.get(group.id)), selected = new Set(this.selections?.get(account.spaceId) ?? [])
    const library = this.library.list().filter(skill => !skill.conflict), rows = new Map<string, EffectiveSkill>()
    const add = (skill: EffectiveSkill['skill'], source: EffectiveSkill['source']) => {
      if (rows.get(skill.name)?.source !== 'managed') rows.set(skill.name, { skill, source })
    }
    for (const pack of this.packs?.store.list() ?? []) {
      const children = library.filter(skill => pack.skills.includes(skill.name))
      if (!children.length) continue
      const source = group.kind === 'admin' || this.packs?.grants.get(group.id).includes(pack.name) ? 'managed'
        : pack.published && this.packs?.selections.get(account.spaceId).includes(pack.name) ? 'selected' : undefined
      if (!source) continue
      for (const skill of children) add(skill, source)
      if (pack.note && !pack.note.conflict) add(pack.note, source)
    }
    for (const skill of library) {
      const source = group.kind === 'admin' || granted.has(skill.name) ? 'managed' : skill.published && selected.has(skill.name) ? 'selected' : undefined
      if (source) add(skill, source)
    }
    return [...rows.values()].sort((a, b) => a.skill.name.localeCompare(b.skill.name))
  }
}
