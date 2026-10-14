import { sameContributionReceipt, type ContributionReceipt } from '../domain/contribution-receipt.js'
import { libraryContributionCredit, libraryProvenanceRevision } from '../domain/library-contribution.js'
import type { SkillPackState } from '../ports/skill-packs.js'
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
    private readonly distribution: SkillDistributionPort, private readonly onReconcile?: () => void | Promise<void>, private readonly packs?: SkillPackState) {}
  impact(name: string) {
    const sources = this.accounts.list().map(account => this.effective.effective(account.username).find(row => row.skill.name === name)?.source)
    const selecting = this.accounts.list().filter(account => this.selections.get(account.spaceId).includes(name) || this.packs?.store.list().some(pack => pack.skills.includes(name) && this.packs?.selections.get(account.spaceId).includes(pack.name)))
    return { managedMembers: sources.filter(source => source === 'managed').length, selectedMembers: selecting.length }
  }
  revision(name: string): unknown {
    return this.accounts.list().map(account => [account.spaceId, account.groupId, account.disabled,
      this.grants.get(account.groupId).includes(name), this.selections.get(account.spaceId).includes(name), this.packs?.grants.get(account.groupId), this.packs?.selections.get(account.spaceId)]).sort()
  }
  grantCount(id: string): number {
    return this.accounts.listGroups().find(group => group.id === id)?.kind === 'admin' ? this.library.list().length : this.grants.get(id).length + (this.packs?.grants.get(id).length ?? 0)
  }
  contributionGroups() { return this.accounts.listGroups().filter(group => group.kind === 'ordinary').map(group => this.group(group.id)) }
  group(id: string): CommunitySkillGroupView {
    const group = requiredCommunityGroup(this.accounts.listGroups(), id), granted = new Set(this.grants.get(id))
    return { group, skills: this.library.list().map(skill => ({ name: skill.name, description: skill.description, conflict: !!skill.conflict, granted: group.kind === 'admin' || granted.has(skill.name) })),
      packs: this.packs?.store.list().map(pack => ({ name: pack.name, description: pack.description, granted: group.kind === 'admin' || !!this.packs?.grants.get(id).includes(pack.name), empty: !pack.skills.length })) ?? [],
      members: this.accounts.list().filter(account => account.groupId === id).length, revision: JSON.stringify([this.library.list().map(row => ({ ...row, ...(row.provenance ? { provenance: libraryProvenanceRevision(row.provenance) } : {}) })), this.packs?.store.list(), this.packs?.grants.get(id), [...granted].sort(), this.accounts.list().map(account => [account.spaceId, account.groupId, account.disabled]).sort()]) }
  }
  grantContribution(id: string, name: string, receipt: ContributionReceipt): void {
    if (sameContributionReceipt(this.grants.contributionReceipt?.(id, name), receipt)) return
    const current = this.group(id); assertOrdinaryGroup(current.group)
    if (!current.skills.some(skill => skill.name === name && (!skill.conflict || skill.granted))) throw new BusinessRuleError('invalid', 'Select skills from the library.', 'skill-unavailable')
    if (this.grants.grantContribution) this.grants.grantContribution(id, name, receipt)
    else this.grants.set(id, [...new Set([...this.grants.get(id), name])])
  }
  async save(id: string, names: readonly string[], revision: string, packNames?: readonly string[]): Promise<CommunitySkillGroupView> {
    const current = this.group(id)
    assertOrdinaryGroup(current.group)
    if (revision !== current.revision) throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
    if (names.some(name => !current.skills.some(skill => skill.name === name && (!skill.conflict || skill.granted)))) throw new BusinessRuleError('invalid', 'Select skills from the library.', 'skill-unavailable')
    if (packNames?.some(name => !current.packs?.some(pack => pack.name === name))) throw new BusinessRuleError('invalid', 'Select packs from the library.', 'skill-unavailable')
    this.grants.set(id, names)
    if (packNames) this.packs?.grants.set(id, packNames)
    await this.reconcile()
    return this.group(id)
  }
  market(username: string, overridden: readonly string[]) {
    const effective = new Map(this.effective.effective(username).map(row => [row.skill.name, row.source]))
    const account = this.accounts.get(username)
    const group = this.accounts.listGroups().find(group => group.id === account?.groupId)
    const direct = new Set(account ? this.grants.get(account.groupId) : [])
    return this.library.list().filter(skill => !skill.conflict && (skill.published || group?.kind === 'admin' || direct.has(skill.name))).map(skill => {
      const source = effective.get(skill.name) ?? null
      return { ...(libraryContributionCredit(skill.provenance) ? { contribution: libraryContributionCredit(skill.provenance)! } : {}), name: skill.name, description: skill.description, source, selectable: skill.published && source !== 'managed', selectedDirectly: this.selections.get(this.accounts.get(username)?.spaceId ?? '').includes(skill.name), status: overridden.includes(skill.name) ? 'overridden' as const : source ?? 'install' as const }
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
    await this.onReconcile?.()
    const rows = this.library.list(), accounts = this.accounts.list()
    for (const pack of this.packs?.store.list() ?? []) {
      if (pack.renamedFrom) {
        for (const group of this.accounts.listGroups()) {
          const names = this.packs!.grants.get(group.id)
          if (names.includes(pack.renamedFrom)) this.packs!.grants.set(group.id, names.map(name => name === pack.renamedFrom ? pack.name : name))
        }
        for (const account of accounts) {
          const names = this.packs!.selections.get(account.spaceId)
          if (names.includes(pack.renamedFrom)) this.packs!.selections.set(account.spaceId, names.map(name => name === pack.renamedFrom ? pack.name : name))
        }
        this.packs!.store.remove(pack.renamedFrom)
        const { renamedFrom, ...settled } = pack
        void renamedFrom
        this.packs!.store.save(settled)
      }
    }
    for (const pack of this.packs?.store.list() ?? []) {
      const skills = pack.skills.filter(name => rows.some(skill => skill.name === name))
      if (skills.length !== pack.skills.length) this.packs!.store.save({ ...pack, skills })
    }
    const packs = this.packs?.store.list() ?? []
    this.packs?.grants.retain(this.accounts.listGroups().map(group => group.id), packs.map(pack => pack.name))
    this.packs?.selections.retain(accounts.map(account => account.spaceId), packs.filter(pack => pack.published).map(pack => pack.name))
    this.grants.retain(this.accounts.listGroups().map(group => group.id), rows.map(skill => skill.name))
    this.selections.retain(accounts.map(account => account.spaceId), rows.filter(skill => skill.published).map(skill => skill.name))
    await this.distribution.synchronize(accounts.filter(account => !account.disabled).map(account => ({ spaceId: account.spaceId, skills: this.effective.effective(account.username).map(row => row.skill) })))
    this.pending = false
    } catch { throw new BusinessRuleError('conflict', 'Skill changes were saved but distribution is incomplete. Retry synchronization.', 'skill-sync-failed') }
  }
}
