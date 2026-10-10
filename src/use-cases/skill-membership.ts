import { BusinessRuleError } from '../domain/business-error.js'
import { assertOrdinaryGroup, requiredCommunityGroup } from '../domain/community-group.js'
import type { CommunitySkillGroupView } from '../domain/admin-contract.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { SkillAssignmentsPort, SkillDistributionPort } from '../ports/member-skills.js'
import type { MemberEffectiveSkills } from './member-effective-skills.js'

/** Grant policy and desired directories; invoked inside the library mutation queue. */
export class SkillMembership {
  private pending = false
  synchronization() { return { pending: this.pending } }
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly library: Pick<SkillLibraryStorePort, 'list'>, private readonly grants: SkillAssignmentsPort,
    private readonly selections: SkillAssignmentsPort, private readonly effective: MemberEffectiveSkills,
    private readonly distribution: SkillDistributionPort) {}
  impact(name: string) {
    const groups = new Set(this.accounts.listGroups().filter(group => group.kind === 'admin' || this.grants.get(group.id).includes(name)).map(group => group.id))
    const accounts = this.accounts.list()
    return { managedMembers: accounts.filter(account => groups.has(account.groupId)).length,
      selectedMembers: accounts.filter(account => this.selections.get(account.spaceId).includes(name)).length }
  }
  revision(name: string): unknown {
    return this.accounts.list().map(account => [account.spaceId, account.groupId, account.disabled,
      this.grants.get(account.groupId).includes(name), this.selections.get(account.spaceId).includes(name)]).sort()
  }
  grantCount(id: string): number {
    return this.accounts.listGroups().find(group => group.id === id)?.kind === 'admin' ? this.library.list().length : this.grants.get(id).length
  }
  group(id: string): CommunitySkillGroupView {
    const group = requiredCommunityGroup(this.accounts.listGroups(), id), granted = new Set(this.grants.get(id))
    return { group, skills: this.library.list().map(skill => ({ name: skill.name, description: skill.description, conflict: !!skill.conflict, granted: group.kind === 'admin' || granted.has(skill.name) })),
      members: this.accounts.list().filter(account => account.groupId === id).length, revision: JSON.stringify([this.library.list(), [...granted].sort(), this.accounts.list().map(account => [account.spaceId, account.groupId, account.disabled]).sort()]) }
  }
  async save(id: string, names: readonly string[], revision: string): Promise<CommunitySkillGroupView> {
    const current = this.group(id)
    assertOrdinaryGroup(current.group)
    if (revision !== current.revision) throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
    if (names.some(name => !current.skills.some(skill => skill.name === name && (!skill.conflict || skill.granted)))) throw new BusinessRuleError('invalid', 'Select skills from the library.', 'skill-unavailable')
    this.grants.set(id, names)
    await this.reconcile()
    return this.group(id)
  }
  market(username: string, overridden: readonly string[]) {
    const effective = new Map(this.effective.effective(username).map(row => [row.skill.name, row.source]))
    return this.library.list().filter(skill => !skill.conflict && (skill.published || effective.has(skill.name))).map(skill => {
      const source = effective.get(skill.name) ?? null
      return { name: skill.name, description: skill.description, source, status: overridden.includes(skill.name) ? 'overridden' as const : source ?? 'install' as const }
    })
  }
  async select(username: string, name: string, selected: boolean): Promise<void> {
    const account = this.accounts.get(username)
    const skill = this.library.list().find(row => row.name === name && row.published && !row.conflict)
    if (!account || !skill || this.effective.effective(username).some(row => row.skill.name === name && row.source === 'managed')) throw new BusinessRuleError('conflict', 'Skill selection is unavailable.', 'skill-unavailable')
    const names = this.selections.get(account.spaceId).filter(value => value !== name)
    this.selections.set(account.spaceId, selected ? [...names, name] : names)
    await this.reconcile()
  }
  async reconcile(): Promise<void> {
    this.pending = true
    try {
    const rows = this.library.list(), accounts = this.accounts.list()
    this.grants.retain(this.accounts.listGroups().map(group => group.id), rows.map(skill => skill.name))
    this.selections.retain(accounts.map(account => account.spaceId), rows.filter(skill => skill.published).map(skill => skill.name))
    await this.distribution.synchronize(accounts.filter(account => !account.disabled).map(account => ({ spaceId: account.spaceId, skills: this.effective.effective(account.username).map(row => row.skill) })))
    this.pending = false
    } catch { throw new BusinessRuleError('conflict', 'Skill changes were saved but distribution is incomplete. Retry synchronization.', 'skill-sync-failed') }
  }
}
