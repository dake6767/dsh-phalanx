import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { EffectiveSkill, SkillAssignmentsPort } from '../ports/member-skills.js'

/** The shared eligibility policy for readonly distribution and market state. */
export class MemberEffectiveSkills {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'listGroups'>,
    private readonly library: Pick<SkillLibraryStorePort, 'list'>, private readonly grants: Pick<SkillAssignmentsPort, 'get'>,
    private readonly selections?: Pick<SkillAssignmentsPort, 'get'>) {}
  effective(username: string): readonly EffectiveSkill[] {
    const account = this.accounts.get(username)
    if (!account || account.disabled) return []
    const group = this.accounts.listGroups().find(group => group.id === account.groupId)
    if (!group) return []
    const granted = new Set(this.grants.get(group.id)), selected = new Set(this.selections?.get(account.spaceId) ?? [])
    return this.library.list().flatMap<EffectiveSkill>(skill => {
      if (skill.conflict) return []
      const source = group.kind === 'admin' || granted.has(skill.name) ? 'managed' : skill.published && selected.has(skill.name) ? 'selected' : undefined
      return source ? [{ skill, source }] : []
    }).sort((a, b) => a.skill.name.localeCompare(b.skill.name))
  }
}
