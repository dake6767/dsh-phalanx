import type { PluginContributionAdministrationPort } from '../ports/plugin-contribution-administration.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { ContributionSetup, ContributionDeclaration, MemberContribution } from '../domain/member-contribution.js'
import type { CommunityContributionReview, CommunityPluginUpstreamInput, CommunitySkillPreview } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { assertPluginIdentity } from '../domain/plugin-library.js'
import type { PluginContributionInput, PluginContributionPreparationPort, PluginContributionPort } from '../ports/plugin-contributions.js'
import type { PluginLibrary } from './plugin-library.js'

/** Private precheck and artifact transfer; the plugin library retains selection and impact ownership. */
export class PluginContributions implements PluginContributionPort {
  constructor(private readonly preparation: PluginContributionPreparationPort, private readonly library: PluginLibrary, private readonly administration?: PluginContributionAdministrationPort) {}
  accept(input: PluginContributionInput, signal: AbortSignal, declaration?: ContributionDeclaration, retainWarnings = false) {
    if (input.source === 'npm') assertPluginIdentity(input)
    return this.preparation.prepare(input, signal, declaration, retainWarnings)
  }
  review(actor: CommunityAccountActor, row: MemberContribution, token: string): CommunityContributionReview {
    this.artifact(row)
    const existing = this.library.list(actor).find(plugin => plugin.packageName === row.name)
    const impact = existing ? this.library.impact(actor, row.name) : { revision: 'new', groups: 0, members: 0, selectedMembers: 0 }
    return { name: row.name, description: row.description, markdown: row.markdown, files: row.files, token, revision: impact.revision, replacing: !!existing, managedMembers: impact.members, selectedMembers: impact.selectedMembers ?? 0, ...this.administration?.preview(actor, row) }
  }
  async confirm(actor: CommunityAccountActor, row: MemberContribution, preview: CommunitySkillPreview, committed: () => void, setup?: ContributionSetup): Promise<void> {
    await this.preparation.publish(this.artifact(row), (promoted, retained) => {
      this.library.adoptContribution(actor, promoted.candidate, promoted.prepared, preview.revision, { id: row.id, revision: row.revision, adoption: { row, ...(setup?.maintenance ? { maintenance: setup.maintenance } : {}) }, ...(promoted.checkedFor ? { checkedFor: promoted.checkedFor } : {}) }, () => { retained(); committed() })
    })
  }
  validate(actor: CommunityAccountActor, row: MemberContribution, setup?: ContributionSetup): void {
    if (this.administration) this.administration.validate(actor, row, setup)
    else if (setup !== undefined) throw new BusinessRuleError('invalid', 'Review plugin configuration before adoption.', 'contribution-invalid')
  }
  apply(row: MemberContribution, setup?: ContributionSetup): Promise<readonly string[]> { return this.administration?.apply(row, setup) ?? Promise.resolve([]) }
  test(actor: CommunityAccountActor, row: MemberContribution, input: CommunityPluginUpstreamInput) { if (!this.administration?.test) throw new BusinessRuleError('conflict', 'Upstream testing is unavailable.', 'contribution-unavailable'); return this.administration.test(actor, row, input) }
  adopted(row: MemberContribution): boolean { return !!row.plugin && this.library.contributionAdopted(row.name, row.plugin.prepared.integrity, { id: row.id, revision: row.revision }) }
  collect(rows: readonly MemberContribution[]): Promise<void> { return this.preparation.recover(rows.flatMap(row => row.plugin ? [row.plugin] : [])) }
  private artifact(row: MemberContribution) { if (!row.plugin) throw new BusinessRuleError('missing', 'The plugin contribution is unavailable.', 'contribution-unavailable'); return row.plugin }
}
