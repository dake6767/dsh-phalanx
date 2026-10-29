import { skillMembershipRevision } from '../domain/skill-impact.js'
import { skillGroupView } from '../domain/skill-group.js'
import type { SkillRepositories, SkillUnitOfWork } from '../ports/skill-unit-of-work.js'
import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { SuiteSkillAssignments } from '../domain/suite-install.js'
import { sameContributionReceipt, type ContributionReceipt } from '../domain/contribution-receipt.js'
import { libraryContributionCredit } from '../domain/library-contribution.js'
import type { SkillPackState } from '../ports/skill-packs.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { PlatformDatabaseError } from '../domain/platform-database.js'
import { assertOrdinaryGroup, requiredCommunityGroup } from '../domain/community-group.js'
import type { CommunitySkillGroupView } from '../domain/admin-contract.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { SkillAssignmentsPort, SkillDistributionPort } from '../ports/member-skills.js'
import type { MemberEffectiveSkills } from './member-effective-skills.js'

/** Grant policy and desired directories; invoked inside the library mutation queue. */
export class SkillMembership {
  private pending = false
  private preparedSnapshot: string | undefined
  synchronization() {
    return { pending: this.pending }
  }
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly library: Pick<SkillLibraryStorePort, 'list'>,
    private readonly grants: SkillAssignmentsPort,
    private readonly selections: SkillAssignmentsPort,
    private readonly effective: MemberEffectiveSkills,
    private readonly distribution: SkillDistributionPort,
    private readonly onReconcile?: () => void | Promise<void>,
    private readonly packs?: SkillPackState,
    private readonly transaction?: SkillUnitOfWork['run'],
  ) {}
  async impact(name: string) {
    const accounts = await this.accounts.list(),
      packs = (await this.packs?.store.list()) ?? []
    const sources = await Promise.all(
      accounts.map(async account => (await this.effective.effective(account.username)).find(row => row.skill.name === name)?.source),
    )
    const selecting = await Promise.all(
      accounts.map(async account => {
        const selected = await this.selections.get(account.spaceId),
          packChoices = (await this.packs?.selections.get(account.spaceId)) ?? []
        return selected.includes(name) || packs.some(pack => pack.skills.includes(name) && packChoices.includes(pack.name))
      }),
    )
    return { managedMembers: sources.filter(source => source === 'managed').length, selectedMembers: selecting.filter(Boolean).length }
  }
  async revision(name: string): Promise<unknown> {
    return skillMembershipRevision(
      await Promise.all(
        (await this.accounts.list()).map(async account => ({
          spaceId: account.spaceId,
          groupId: account.groupId,
          disabled: account.disabled,
          granted: (await this.grants.get(account.groupId)).includes(name),
          selected: (await this.selections.get(account.spaceId)).includes(name),
          packGrants: await this.packs?.grants.get(account.groupId),
          packSelections: await this.packs?.selections.get(account.spaceId),
        })),
      ),
    )
  }

  async grantCount(id: string): Promise<number> {
    return (await this.grants.get(id)).length + ((await this.packs?.grants.get(id))?.length ?? 0)
  }
  async contributionGroups() {
    return Promise.all((await this.accounts.listGroups()).filter(group => group.kind === 'ordinary').map(group => this.group(group.id)))
  }
  async group(id: string): Promise<CommunitySkillGroupView> {
    const group = requiredCommunityGroup(await this.accounts.listGroups(), id),
      granted = new Set(await this.grants.get(id)),
      library = await this.library.list(),
      packs = await this.packs?.store.list(),
      packGrants = await this.packs?.grants.get(id),
      accounts = await this.accounts.list()
    return skillGroupView({ group, library, packs, packGrants, granted, accounts })
  }

  async grantContribution(id: string, name: string, receipt: ContributionReceipt): Promise<void> {
    if (sameContributionReceipt(await this.grants.contributionReceipt?.(id, name), receipt)) return
    const current = await this.group(id)
    assertOrdinaryGroup(current.group)
    if (!current.skills.some(skill => skill.name === name && (!skill.conflict || skill.granted)))
      throw new BusinessRuleError('invalid', 'Select skills from the library.', 'skill-unavailable')
    if (this.grants.grantContribution) await this.grants.grantContribution(id, name, receipt)
    else await this.grants.set(id, [...new Set([...(await this.grants.get(id)), name])])
  }
  async save(id: string, names: readonly string[], revision: string, packNames?: readonly string[]): Promise<CommunitySkillGroupView> {
    const current = await this.group(id)
    if (revision !== current.revision) throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
    if (names.some(name => !current.skills.some(skill => skill.name === name && (!skill.conflict || skill.granted))))
      throw new BusinessRuleError('invalid', 'Select skills from the library.', 'skill-unavailable')
    if (packNames?.some(name => !current.packs?.some(pack => pack.name === name)))
      throw new BusinessRuleError('invalid', 'Select packs from the library.', 'skill-unavailable')
    if (this.transaction)
      await this.transaction(async repositories => {
        await repositories.grants.set(id, names)
        if (packNames) await repositories.packs.grants.set(id, packNames)
      })
    else {
      await this.grants.set(id, names)
      if (packNames) await this.packs?.grants.set(id, packNames)
    }
    await this.reconcile()
    return await this.group(id)
  }
  async market(username: string, overridden: readonly string[]) {
    const effective = new Map((await this.effective.effective(username)).map(row => [row.skill.name, row.source]))
    const account = await this.accounts.get(username)
    const direct = new Set(account ? await this.grants.get(account.groupId) : [])
    const selectedNames = await this.selections.get(account?.spaceId ?? '')
    return (await this.library.list())
      .filter(skill => !skill.conflict && (skill.published || direct.has(skill.name)))
      .map(skill => {
        const source = effective.get(skill.name) ?? null
        return {
          ...(libraryContributionCredit(skill.provenance) ? { contribution: libraryContributionCredit(skill.provenance)! } : {}),
          name: skill.name,
          description: skill.description,
          source,
          selectable: skill.published && source !== 'managed',
          selectedDirectly: selectedNames.includes(skill.name),
          status: overridden.includes(skill.name) ? ('overridden' as const) : (source ?? ('install' as const)),
        }
      })
  }
  async select(username: string, name: string, selected: boolean): Promise<void> {
    const account = await this.accounts.get(username)
    const skill = (await this.library.list()).find(row => row.name === name && row.published && !row.conflict)
    if (!account || !skill || (await this.effective.effective(username)).some(row => row.skill.name === name && row.source === 'managed'))
      throw new BusinessRuleError('conflict', 'Skill selection is unavailable.', 'skill-unavailable')
    const names = (await this.selections.get(account.spaceId)).filter(value => value !== name)
    await this.selections.set(account.spaceId, selected ? [...names, name] : names)
    await this.reconcile()
  }
  async snapshotSuiteAssignments(names: readonly string[]): Promise<SuiteSkillAssignments> {
    return {
      grants: await Promise.all(
        (await this.accounts.listGroups()).map(async row => ({ id: row.id, names: (await this.grants.get(row.id)).filter(name => names.includes(name)) })),
      ),
      selections: await Promise.all(
        (await this.accounts.list()).map(async row => ({
          id: row.spaceId,
          names: (await this.selections.get(row.spaceId)).filter(name => names.includes(name)),
        })),
      ),
      packs: ((await this.packs?.store.list()) ?? []).map(row => ({ id: row.name, names: row.skills })),
    }
  }
  async pruneSelections(repositories: SkillRepositories): Promise<void> {
    const spaces = (await this.accounts.list()).map(account => account.spaceId)
    await repositories.selections.retain(
      spaces,
      (await repositories.library.list()).filter(skill => skill.published).map(skill => skill.name),
    )
    await repositories.packs.selections.retain(
      spaces,
      (await repositories.packs.store.list()).filter(pack => pack.published).map(pack => pack.name),
    )
  }
  async restoreSuiteAssignments(snapshot: SuiteSkillAssignments, repositories?: SkillRepositories): Promise<void> {
    const grants = repositories?.grants ?? this.grants,
      selections = repositories?.selections ?? this.selections,
      packs = repositories?.packs ?? this.packs
    const [groups, accounts] = await Promise.all([this.accounts.listGroups(), this.accounts.list()])
    const merge = (current: readonly string[], saved: readonly string[]) => [...new Set([...current, ...saved])]
    for (const row of snapshot.grants) if (groups.some(group => group.id === row.id)) await grants.set(row.id, merge(await grants.get(row.id), row.names))
    for (const row of snapshot.selections)
      if (accounts.some(account => account.spaceId === row.id)) await selections.set(row.id, merge(await selections.get(row.id), row.names))
    for (const row of snapshot.packs) {
      const current = (await packs?.store.list())?.find(pack => pack.name === row.id)
      if (current) await packs!.store.save({ ...current, skills: merge(row.names, current.skills) })
    }
  }
  async reconcile(reuse = false, dependencies?: { readonly spaceId: string; readonly versions: readonly RuntimeDependencyVersion[] }): Promise<void> {
    const previous = this.preparedSnapshot
    this.preparedSnapshot = undefined
    this.pending = true
    try {
      await this.onReconcile?.()
      const before = await this.preparationState(dependencies)
      if (reuse && before && JSON.stringify(before) === previous) {
        this.preparedSnapshot = previous
        this.pending = false
        return
      }
      const accounts = await this.accounts.list()
      const plans = await Promise.all(
        accounts.filter(account => !account.disabled).map(async account => ({ account, expand: await this.effective.prepare(account.username) })),
      )
      await this.distribution.synchronize(
        plans.map(({ account, expand }) => ({
          ...(dependencies?.spaceId === account.spaceId ? { runtimeDependencies: dependencies.versions } : {}),
          spaceId: account.spaceId,
          skills: expand().map(row => row.skill),
        })),
      )
      const after = await this.preparationState(dependencies)
      if (before && after && JSON.stringify(before.inputs) === JSON.stringify(after.inputs)) this.preparedSnapshot = JSON.stringify(after)
      this.pending = false
    } catch (error) {
      // Synchronization callers can wait for a concurrent committed-view publication.
      if (error instanceof PlatformDatabaseError && error.code === 'unavailable') throw error
      throw new BusinessRuleError('conflict', 'Skill changes were saved but distribution is incomplete. Retry synchronization.', 'skill-sync-failed')
    }
  }
  private async preparationState(dependencies?: { readonly spaceId: string; readonly versions: readonly RuntimeDependencyVersion[] }) {
    if (!this.distribution.snapshot) return undefined
    const accounts = await this.accounts.list(),
      groups = await this.accounts.listGroups()
    const members = await Promise.all(
      accounts
        .filter(account => !account.disabled)
        .map(async account => ({
          ...(dependencies?.spaceId === account.spaceId ? { runtimeDependencies: dependencies.versions } : {}),
          spaceId: account.spaceId,
          skills: (await this.effective.effective(account.username)).map(row => row.skill),
        })),
    )
    const input = [
      await this.library.list(),
      accounts,
      groups,
      await Promise.all(groups.map(async group => [group.id, await this.grants.get(group.id), await this.packs?.grants.get(group.id)])),
      await Promise.all(
        accounts.map(async account => [account.spaceId, await this.selections.get(account.spaceId), await this.packs?.selections.get(account.spaceId)]),
      ),
      await this.packs?.store.list(),
    ]
    const distribution = await this.distribution.snapshot(members)
    return { inputs: [input, distribution.inputs], outputs: distribution.outputs }
  }
}
