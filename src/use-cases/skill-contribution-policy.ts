import type { CommunityAccountActor } from '../domain/community-account.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { SkillMembership } from './skill-membership.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { ContributionDeclaration, ContributionSetup, MemberContribution } from '../domain/member-contribution.js'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { CommunityRuntimeDependencyView } from '../domain/admin-contract.js'

/** Read-only contribution planning; the library retains authorization and its mutation owner. */
export function planSkillContributionDependencies(
  existing: LibrarySkill | undefined,
  available: readonly Pick<CommunityRuntimeDependencyView, 'name' | 'current'>[],
  declaration: ContributionDeclaration,
) {
  const previous = existing?.provenance?.versions.at(-1)?.declaration?.requiredCommands ?? []
  const requirements = (declaration.requiredCommands ?? []).map(command => {
    const dependency = available.find(row => row.current?.commands.includes(command.name))?.name
    return { ...command, ...(dependency ? { dependency } : {}), added: !previous.some(row => row.name === command.name) }
  })
  return {
    references: [...new Set([...(existing?.runtimeDependencies ?? []), ...requirements.flatMap(row => (row.dependency ? [row.dependency] : []))])],
    requirements,
    removed: previous.filter(row => !requirements.some(next => next.name === row.name)).map(row => row.name),
  }
}

export function assertSkillContributionSetup(setup: ContributionSetup): void {
  if (
    !setup ||
    typeof setup !== 'object' ||
    Array.isArray(setup) ||
    Object.keys(setup).some(key => !['execution', 'published', 'groups', 'maintenance', 'configuration', 'runtimeDependencies'].includes(key))
  )
    throw new BusinessRuleError('invalid', 'Review distribution choices.', 'contribution-invalid')
  if (
    (setup.published !== undefined && typeof setup.published !== 'boolean') ||
    (setup.groups !== undefined &&
      (!Array.isArray(setup.groups) || setup.groups.length > 64 || new Set(setup.groups.map(row => row.id)).size !== setup.groups.length))
  )
    throw new BusinessRuleError('invalid', 'Review distribution choices.', 'contribution-invalid')
}

interface ContributionLifecycle {
  assertAdmin(actor: CommunityAccountActor): Promise<void>
  group(actor: CommunityAccountActor, id: string): ReturnType<SkillMembership['group']>
}
/** Contribution planning shares the library authorization and group policy. */
export class SkillContributionPolicy {
  constructor(
    private readonly store: SkillLibraryStorePort,
    private readonly membership: SkillMembership | undefined,
    private readonly runtimeDependencies: (Pick<RuntimeDependencies, 'readReady'> & Partial<Pick<RuntimeDependencies, 'list'>>) | undefined,
    private readonly lifecycle: ContributionLifecycle,
  ) {}
  private requiredMembership(): SkillMembership {
    if (!this.membership) throw new BusinessRuleError('missing', 'Skills are unavailable.', 'skill-unavailable')
    return this.membership
  }
  async contributionDependencies(actor: CommunityAccountActor, name: string, declaration: import('../domain/member-contribution.js').ContributionDeclaration) {
    await this.lifecycle.assertAdmin(actor)
    const existing = (await this.store.list()).find(row => row.name === name),
      available = (await this.runtimeDependencies?.list?.(actor)) ?? []
    return planSkillContributionDependencies(existing, available, declaration)
  }

  async validateContributionDependencies(actor: CommunityAccountActor, row: MemberContribution, names: readonly string[]): Promise<void> {
    await this.lifecycle.assertAdmin(actor)
    if (!Array.isArray(names) || names.length > 128 || names.some(name => typeof name !== 'string') || new Set(names).size !== names.length)
      throw new BusinessRuleError('invalid', 'Select prepared runtime dependencies.', 'runtime-dependency-invalid')
    if (names.length) {
      if (!this.runtimeDependencies) throw new BusinessRuleError('conflict', 'Runtime dependencies are unavailable.', 'runtime-dependency-unavailable')
      await this.runtimeDependencies.readReady(names)
    }
    const selected = ((await this.runtimeDependencies?.list?.(actor)) ?? []).filter(item => names.includes(item.name))
    if (row.declaration.requiredCommands?.some(command => !selected.some(item => item.current?.commands.includes(command.name))))
      throw new BusinessRuleError('conflict', 'Prepare the required commands before adoption.', 'runtime-dependency-unavailable')
  }
  async contributionGroups(actor: CommunityAccountActor) {
    await this.lifecycle.assertAdmin(actor)
    return await this.requiredMembership().contributionGroups()
  }
  async validateContributionDistribution(actor: CommunityAccountActor, setup?: ContributionSetup): Promise<void> {
    await this.lifecycle.assertAdmin(actor)
    if (setup === undefined) return
    assertSkillContributionSetup(setup)
    for (const group of setup.groups ?? [])
      if (
        !group ||
        typeof group.id !== 'string' ||
        typeof group.revision !== 'string' ||
        (await this.lifecycle.group(actor, group.id)).group.kind !== 'ordinary' ||
        (await this.lifecycle.group(actor, group.id)).revision !== group.revision
      )
        throw new BusinessRuleError('conflict', 'Review the group impact again.', 'skill-preview-changed')
  }
}
