import type { CommunityAccountActor } from '../domain/community-account.js'
import type { ContributionSetup, MemberContribution } from '../domain/member-contribution.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginContributionDistributionPort } from '../ports/plugin-contribution-administration.js'
import type { ManagedPluginAdministration } from './managed-plugin-administration.js'
import type { PluginMarket } from './plugin-market.js'
import { BusinessRuleError } from '../domain/business-error.js'

/** Group and publication owners retain policy; a receipt makes confirmed-plan replay idempotent. */
export class PluginContributionDistribution implements PluginContributionDistributionPort {
  constructor(private readonly library: PluginLibraryStorePort, private readonly managed: ManagedPluginAdministration, private readonly market: PluginMarket) {}
  groups(actor: CommunityAccountActor, packageName: string) { return this.managed.contributionGroups(actor, packageName) }
  validate(actor: CommunityAccountActor, packageName: string, setup?: ContributionSetup): void {
    if (!setup) return
    if (setup.credentialSharingConfirmed !== undefined && typeof setup.credentialSharingConfirmed !== 'boolean' || setup.published !== undefined && typeof setup.published !== 'boolean' || setup.groups !== undefined && (!Array.isArray(setup.groups) || setup.groups.length > 64 || new Set(setup.groups.map(row => row.id)).size !== setup.groups.length || setup.groups.some(row => !row || typeof row.id !== 'string' || typeof row.revision !== 'string'))) throw new BusinessRuleError('invalid', 'Review plugin distribution choices.', 'contribution-invalid')
    this.managed.validateContributionGroups(actor, setup.groups ?? [], packageName)
  }
  apply(contribution: MemberContribution, setup?: ContributionSetup): readonly string[] {
    const row = this.library.list().find(row => row.packageName === contribution.name)
    if (!row || row.current?.integrity !== contribution.plugin?.prepared.integrity) return ['The current plugin version changed; the contribution distribution was not applied.']
    if (row.contributionDistributionReceipt?.id === contribution.id && row.contributionDistributionReceipt.revision === contribution.revision) return row.contributionDistributionReceipt.warnings ?? []
    const warnings = [...this.managed.adoptContribution(row.packageName, setup?.groups ?? [], { id: contribution.id, revision: contribution.revision })]
    if (setup?.published === true) warnings.push(...this.market.publishContribution(row.packageName, setup.credentialSharingConfirmed === true, { id: contribution.id, revision: contribution.revision }))
    const current = this.library.list().find(plugin => plugin.packageName === row.packageName)!
    this.library.save({ ...current, contributionDistributionReceipt: { id: contribution.id, revision: contribution.revision, ...(warnings.length ? { warnings } : {}) } })
    return warnings
  }
}
