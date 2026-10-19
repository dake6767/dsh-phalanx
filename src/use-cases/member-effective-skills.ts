import { combineAcquisitionSources, type AcquisitionSource } from '../domain/acquisition-sources.js'
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
    const library = this.library.list().filter(skill => !skill.conflict), skills = new Map(library.map(skill => [skill.name, skill]))
    const sources: AcquisitionSource[] = [
      { source: 'managed', names: library.filter(skill => group.kind === 'admin' || granted.has(skill.name)).map(skill => skill.name) },
      { source: 'selected', names: library.filter(skill => skill.published && selected.has(skill.name)).map(skill => skill.name) },
    ]
    for (const pack of this.packs?.store.list() ?? []) {
      const children = library.filter(skill => pack.skills.includes(skill.name))
      if (!children.length) continue
      const source = group.kind === 'admin' || this.packs?.grants.get(group.id).includes(pack.name) ? 'managed'
        : pack.published && this.packs?.selections.get(account.spaceId).includes(pack.name) ? 'selected' : undefined
      if (!source) continue
      const names = children.map(skill => skill.name)
      if (pack.note && !pack.note.conflict) { skills.set(pack.note.name, pack.note); names.push(pack.note.name) }
      sources.push({ source, names })
    }
    return [...combineAcquisitionSources(sources)].map(([name, source]) => ({ skill: skills.get(name)!, source })).sort((a, b) => a.skill.name.localeCompare(b.skill.name))
  }
}
