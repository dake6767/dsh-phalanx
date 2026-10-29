import { skillImpactRevision, skillMembershipRevision, type SkillImpactMember } from '../domain/skill-impact.js'
import { pluginImpact } from '../domain/plugin-impact.js'
import { PluginLibraryMembership } from './plugin-library-membership.js'
import type { LibraryPlugin } from '../domain/plugin-library.js'
import type { PluginAccessSyntaxPort } from '../ports/plugin-access.js'
import { applyPluginContributionFacts } from './contribution-plugin-facts.js'
import type { ContributionTransactionsPort } from '../ports/contribution-transactions.js'
import type { ContributionUnitOfWork } from '../ports/contribution-unit-of-work.js'
import type { ContributionRecord } from '../ports/contribution-rows.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { MemberContribution, ContributionSetup } from '../domain/member-contribution.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { applySkillContributionFacts } from './contribution-skill-facts.js'

const kind = (row: MemberContribution) => row.kind ?? 'skill'
const sameAuthor = (a: CommunityAccountActor, b: CommunityAccountActor) => a.username === b.username && a.spaceId === b.spaceId
const changed = () => new BusinessRuleError('conflict', 'This contribution changed. Review it again.', 'contribution-unavailable')

/** A submitted version, its library facts and all decisions commit together; no adoption intent survives. */
export class ContributionTransactions implements ContributionTransactionsPort {
  constructor(
    private readonly work: ContributionUnitOfWork,
    private readonly pluginSyntax: PluginAccessSyntaxPort,
  ) {}
  async replay(actor: CommunityAccountActor, record: ContributionRecord): Promise<void> {
    await this.work.run(async rows => {
      await rows.contributions.lockName(kind(record.row), record.row.name)
      await rows.accounts.lock(actor, actor, [])
      const current = await rows.contributions.get(record.row.id)
      if (current?.row.status !== 'adopted' || current.row.revision !== record.row.revision) throw changed()
    })
  }
  async submit(actor: CommunityAccountActor, input: MemberContribution): Promise<MemberContribution> {
    const proposed = structuredClone(input)
    if (!sameAuthor(proposed.contributor, actor) || proposed.contributor.sessionEpoch !== actor.sessionEpoch || proposed.status !== 'pending') throw changed()
    return this.work.run(async rows => {
      await rows.contributions.lockName(kind(proposed), proposed.name)
      await rows.accounts.lockMember(actor)
      await rows.submission.check(actor, proposed)
      const pending = (await rows.contributions.list()).filter(record => record.row.status === 'pending' && sameAuthor(record.row.contributor, actor))
      const previous = pending.find(record => kind(record.row) === kind(proposed) && record.row.name === proposed.name)
      if (!previous && pending.length >= 20)
        throw new BusinessRuleError('conflict', 'Withdraw a pending contribution or wait for review; the limit is 20.', 'contribution-limit')
      const row = { ...proposed, id: previous?.row.id ?? proposed.id }
      await rows.contributions.save(row, previous?.revision)
      return row
    })
  }
  async withdraw(actor: CommunityAccountActor, record: ContributionRecord, updatedAt: number): Promise<void> {
    await this.work.run(async rows => {
      await rows.contributions.lockName(kind(record.row), record.row.name)
      await rows.accounts.lockMember(actor)
      const row = await rows.contributions.lock(record.row.id, record.revision)
      if (row.status !== 'pending' || !sameAuthor(row.contributor, actor)) throw changed()
      await rows.contributions.save({ ...row, status: 'withdrawn', updatedAt }, record.revision)
    })
  }
  async decline(actor: CommunityAccountActor, record: ContributionRecord, reason: string, updatedAt: number): Promise<void> {
    await this.work.run(async rows => {
      await rows.contributions.lockName(kind(record.row), record.row.name)
      await rows.accounts.lock(actor, record.row.contributor, [])
      const row = await rows.contributions.lock(record.row.id, record.revision)
      if (row.status !== 'pending') throw changed()
      await rows.contributions.save({ ...row, status: 'declined', reason, updatedAt }, record.revision)
    })
  }
  async remove(record: ContributionRecord): Promise<void> {
    await this.work.run(async rows => {
      await rows.contributions.lockName(kind(record.row), record.row.name)
      await rows.contributions.remove(record.row.id, record.revision)
    })
  }
  async plugin(
    actor: CommunityAccountActor,
    record: ContributionRecord,
    plugin: LibraryPlugin,
    setup: ContributionSetup | undefined,
    updatedAt: number,
    committed: () => void,
    impact: string,
  ): Promise<void> {
    await this.work.run(
      async rows => {
        await rows.contributions.lockName('plugin', record.row.name)
        const completed = await rows.contributions.get(record.row.id)
        if (completed?.row.status === 'adopted' && completed.row.revision === record.row.revision) {
          await rows.accounts.lock(actor, actor, [])
          return false
        }
        const pending = (await rows.contributions.list()).filter(
          other => kind(other.row) === 'plugin' && other.row.name === record.row.name && other.row.status === 'pending',
        )
        await rows.accounts.lockDirectory()
        const membership = new PluginLibraryMembership(rows.accounts, rows.pluginGrants, rows.pluginSelections),
          affectedGroups = await membership.impactGroups(record.row.name),
          selected = await rows.pluginSelections.members(record.row.name),
          selectedAccounts = (await rows.accounts.list()).filter(account => selected.includes(account.spaceId))
        await rows.accounts.lock(
          actor,
          record.row.contributor,
          [...new Set([...(setup?.groups ?? []).map(group => group.id), ...affectedGroups.map(group => group.id)])],
          [...pending.map(other => other.row.contributor), ...selectedAccounts],
        )
        await rows.plugins.lock(plugin.packageName, plugin.revision ?? 'none')
        const currentGroups = await membership.impactGroups(record.row.name),
          currentSelected = await rows.pluginSelections.members(record.row.name)
        if (currentGroups.some(group => !affectedGroups.some(before => before.id === group.id)) || currentSelected.some(space => !selected.includes(space)))
          throw new BusinessRuleError('conflict', 'The plugin impact changed. Review it again.', 'plugin-impact-changed')
        const previous = (await rows.plugins.list()).find(row => row.packageName === plugin.packageName)
        if (previous) {
          const references = await rows.expertReferences.lockImpact([{ kind: 'plugin', name: plugin.packageName }])
          if (pluginImpact(previous, await membership.impact(plugin.packageName), references).revision !== impact)
            throw new BusinessRuleError('conflict', 'The plugin impact changed. Review it again.', 'plugin-impact-changed')
        } else if (impact !== 'new') throw new BusinessRuleError('conflict', 'The plugin impact changed. Review it again.', 'plugin-impact-changed')
        const current = await rows.contributions.get(record.row.id)
        if (
          !current ||
          current.revision !== record.revision ||
          current.row.status !== 'pending' ||
          kind(current.row) !== 'plugin' ||
          plugin.packageName !== current.row.name ||
          plugin.current?.integrity !== current.row.plugin?.prepared.integrity ||
          plugin.contributionReceipt?.id !== current.row.id ||
          plugin.contributionReceipt.revision !== current.row.revision
        )
          throw changed()
        const warnings = await applyPluginContributionFacts(rows, plugin, current.row, this.pluginSyntax, setup)
        for (const other of (await rows.contributions.list()).filter(
          other => kind(other.row) === 'plugin' && other.row.name === current.row.name && other.row.status === 'pending',
        )) {
          await rows.contributions.save(
            other.row.id === current.row.id
              ? { ...other.row, status: 'adopted', updatedAt, ...(warnings.length ? { reason: warnings.join(' ') } : {}) }
              : { ...other.row, status: 'declined', updatedAt, reason: 'Another contribution with this name was adopted.' },
            other.revision,
          )
        }
        return true
      },
      written => {
        if (written) committed()
      },
    )
  }
  async skill(
    actor: CommunityAccountActor,
    record: ContributionRecord,
    skill: LibrarySkill,
    setup: ContributionSetup | undefined,
    updatedAt: number,
    impact: string,
  ): Promise<void> {
    await this.work.run(async rows => {
      await rows.contributions.lockName('skill', record.row.name)
      const completed = await rows.contributions.get(record.row.id)
      if (completed?.row.status === 'adopted' && completed.row.revision === record.row.revision) {
        await rows.accounts.lock(actor, actor, [])
        return
      }
      const pending = (await rows.contributions.list()).filter(
        other => kind(other.row) === 'skill' && other.row.name === record.row.name && other.row.status === 'pending',
      )
      await rows.accounts.lock(
        actor,
        record.row.contributor,
        (setup?.groups ?? []).map(group => group.id),
        pending.map(other => other.row.contributor),
      )
      await rows.skillImpact.lock(record.row.name, setup?.published === false)
      const references = await rows.expertReferences.lockImpact([{ kind: 'skill', name: record.row.name }]),
        previous = (await rows.library.list()).find(row => row.name === record.row.name),
        members: SkillImpactMember[] = []
      for (const account of await rows.accounts.list())
        members.push({
          spaceId: account.spaceId,
          groupId: account.groupId,
          disabled: account.disabled,
          granted: (await rows.grants.get(account.groupId)).includes(record.row.name),
          selected: (await rows.selections.get(account.spaceId)).includes(record.row.name),
          packGrants: await rows.packs.grants.get(account.groupId),
          packSelections: await rows.packs.selections.get(account.spaceId),
        })
      const membership = skillMembershipRevision(members)
      if (skillImpactRevision(previous, membership, await rows.packs.store.list(), record.row.name, references.revision) !== impact)
        throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
      const current = await rows.contributions.get(record.row.id)
      if (current?.row.status === 'adopted' && current.row.revision === record.row.revision) return
      if (!current || current.revision !== record.revision || current.row.status !== 'pending') throw changed()
      if (
        kind(current.row) !== 'skill' ||
        skill.name !== current.row.name ||
        skill.hash !== current.row.hash ||
        skill.contributionReceipt?.id !== current.row.id ||
        skill.contributionReceipt.revision !== current.row.revision
      )
        throw changed()
      const warnings = await applySkillContributionFacts(rows, actor, skill, current.row, setup)
      for (const other of (await rows.contributions.list()).filter(
        other => kind(other.row) === 'skill' && other.row.name === current.row.name && other.row.status === 'pending',
      )) {
        await rows.contributions.save(
          other.row.id === current.row.id
            ? { ...other.row, status: 'adopted', updatedAt, ...(warnings.length ? { reason: warnings.join(' ') } : {}) }
            : { ...other.row, status: 'declined', updatedAt, reason: 'Another contribution with this name was adopted.' },
          other.revision,
        )
      }
    })
  }
}
