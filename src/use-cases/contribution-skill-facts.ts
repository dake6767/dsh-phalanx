import type { ContributionRepositories } from '../ports/contribution-unit-of-work.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { ContributionSetup, MemberContribution } from '../domain/member-contribution.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { requiredCommunityGroup } from '../domain/community-group.js'
import { skillGroupView } from '../domain/skill-group.js'
import { readyRuntimeDependencies } from '../domain/runtime-dependency-selection.js'
import { ExecutionAdministration } from './execution-administration.js'

/** Only prepared facts enter this scope; the caller owns post-commit projection and artifact collection. */
export async function applySkillContributionFacts(
  rows: ContributionRepositories,
  actor: CommunityAccountActor,
  skill: LibrarySkill,
  contribution: MemberContribution,
  setup?: ContributionSetup,
): Promise<readonly string[]> {
  await rows.accounts.lock(
    actor,
    contribution.contributor,
    (setup?.groups ?? []).map(group => group.id),
  )
  const library = await rows.library.list(),
    previous = library.find(row => row.name === skill.name)
  if (previous?.rowRevision !== skill.rowRevision) throw new BusinessRuleError('conflict', 'Review the skill again before confirming.', 'skill-preview-changed')
  const versions = readyRuntimeDependencies(await rows.runtime.list(), skill.runtimeDependencies ?? [])
  if (contribution.declaration.requiredCommands?.some(command => !versions.some(version => version.commands.includes(command.name))))
    throw new BusinessRuleError('conflict', 'Prepare the required commands before adoption.', 'runtime-dependency-unavailable')
  const accounts = await rows.accounts.list(),
    groups = await rows.accounts.listGroups(),
    warnings: string[] = []
  const selected: string[] = []
  for (const choice of setup?.groups ?? []) {
    if (!groups.some(group => group.id === choice.id)) {
      warnings.push('A selected group was removed; its grant was not applied.')
      continue
    }
    const view = skillGroupView({
      group: requiredCommunityGroup(groups, choice.id),
      accounts,
      library,
      packs: await rows.packs.store.list(),
      packGrants: await rows.packs.grants.get(choice.id),
      granted: new Set(await rows.grants.get(choice.id)),
    })
    if (view.group.kind !== 'ordinary' || view.revision !== choice.revision)
      throw new BusinessRuleError('conflict', 'Review the group impact again.', 'skill-preview-changed')
    selected.push(choice.id)
  }
  await rows.library.save(skill, skill.rowRevision ?? 'none')
  const current = await rows.library.list()
  const execution = new ExecutionAdministration(
    rows.accounts,
    {
      get: id => {
        const row = current.find(skill => id === 'skill:' + skill.name)
        return row ? { id, version: row.hash } : undefined
      },
      owns: async () => false,
    },
    rows.execution,
    async () => {},
    undefined,
    undefined,
    { readReady: async names => readyRuntimeDependencies(await rows.runtime.list(), names) },
  )
  const executionWarnings = await execution.adoptContribution(contribution, setup?.execution, setup?.configuration?.execution)
  if (executionWarnings.length) return executionWarnings
  const receipt = { id: contribution.id, revision: contribution.revision }
  for (const id of selected) {
    if (!rows.grants.grantContribution) throw Error('Contribution grant receipts require transaction-bound repositories')
    await rows.grants.grantContribution(id, skill.name, receipt)
  }
  const updated = (await rows.library.list()).find(row => row.name === skill.name)!
  await rows.library.save({
    ...updated,
    ...(setup?.published !== undefined ? { published: setup.published, contributionPublicationReceipt: receipt } : {}),
    contributionDistributionReceipt: { ...receipt, ...(warnings.length ? { warnings } : {}) },
  })
  if (setup?.published === false) {
    for (const account of accounts) {
      const choices = await rows.selections.get(account.spaceId)
      if (choices.includes(skill.name))
        await rows.selections.set(
          account.spaceId,
          choices.filter(name => name !== skill.name),
        )
    }
  }
  return warnings
}
