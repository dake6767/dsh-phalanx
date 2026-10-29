import { combineAcquisitionSources, type AcquisitionSource } from '../domain/acquisition-sources.js'
import type { SkillPackViews } from '../ports/skill-packs.js'
import type { CommunityAccountRecord } from '../domain/community-account.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { SkillLibraryView } from '../ports/skill-library.js'
import type { EffectiveSkill, SkillAssignmentsView } from '../ports/member-skills.js'
import type { ExpertSkillsPort } from '../ports/experts.js'

/** Global distribution stays separate from ownership used by platform execution admission. */
export class MemberEffectiveSkills {
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'listGroups'>,
    private readonly library: SkillLibraryView,
    private readonly grants: Pick<SkillAssignmentsView, 'get'>,
    private readonly selections?: Pick<SkillAssignmentsView, 'get'>,
    private readonly packs?: SkillPackViews,
    private readonly experts?: ExpertSkillsPort,
  ) {}
  async effective(username: string): Promise<readonly EffectiveSkill[]> {
    return await this.resolve(username, false)
  }
  async accessible(username: string) {
    return (await this.resolve(username, true)).map(row => row.skill)
  }
  private async resolve(username: string, includeExperts: boolean): Promise<readonly EffectiveSkill[]> {
    const facts = await this.facts(username)
    if (!facts) return []
    await this.library.ready?.()
    const global = this.expand(facts.account, facts.groupId)
    if (!includeExperts) return global
    const experts = (await this.experts?.skills(username)) ?? []
    const entries = new Map(global.map(row => [row.skill.name, row]))
    for (const skill of experts) entries.set(skill.name, { skill, source: 'managed' })
    return [...entries.values()].sort((a, b) => a.skill.name.localeCompare(b.skill.name))
  }
  /** Capture account facts before a projection mutates assignments; expand the resulting local state synchronously. */
  async prepare(username: string): Promise<() => readonly EffectiveSkill[]> {
    const facts = await this.facts(username)
    if (facts) await this.library.ready?.()
    return facts ? () => this.expand(facts.account, facts.groupId) : () => []
  }
  private async facts(username: string) {
    const account = await this.accounts.get(username)
    if (!account || account.disabled) return undefined
    const group = (await this.accounts.listGroups()).find(group => group.id === account.groupId)
    return group ? { account, groupId: group.id } : undefined
  }
  private expand(account: CommunityAccountRecord, groupId: string): readonly EffectiveSkill[] {
    const granted = new Set(this.grants.get(groupId)),
      selected = new Set(this.selections?.get(account.spaceId) ?? [])
    const library = this.library.list().filter(skill => !skill.conflict),
      skills = new Map(library.map(skill => [skill.name, skill]))
    const sources: AcquisitionSource[] = [
      { source: 'managed', names: library.filter(skill => granted.has(skill.name)).map(skill => skill.name) },
      { source: 'selected', names: library.filter(skill => skill.published && selected.has(skill.name)).map(skill => skill.name) },
    ]
    for (const pack of this.packs?.store.list() ?? []) {
      const children = library.filter(skill => pack.skills.includes(skill.name))
      if (!children.length) continue
      const source = this.packs?.grants.get(groupId).includes(pack.name)
        ? 'managed'
        : pack.published && this.packs?.selections.get(account.spaceId).includes(pack.name)
          ? 'selected'
          : undefined
      if (!source) continue
      const names = children.map(skill => skill.name)
      if (pack.note && !pack.note.conflict) {
        skills.set(pack.note.name, pack.note)
        names.push(pack.note.name)
      }
      sources.push({ source, names })
    }
    return [...combineAcquisitionSources(sources)]
      .map(([name, source]) => ({ skill: skills.get(name)!, source }))
      .sort((a, b) => a.skill.name.localeCompare(b.skill.name))
  }
}
