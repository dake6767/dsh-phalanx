import type { CommunityAccountActor } from '../domain/community-account.js'
import type { MemberContribution } from '../domain/member-contribution.js'
import type { CommunitySkillPreview } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { assertPluginIdentity } from '../domain/plugin-library.js'
import type { PluginContributionInput, PluginContributionPreparationPort, PluginContributionPort } from '../ports/plugin-contributions.js'
import type { PluginLibrary } from './plugin-library.js'

/** Private precheck and artifact transfer; the plugin library retains selection and impact ownership. */
export class PluginContributions implements PluginContributionPort {
  constructor(private readonly preparation: PluginContributionPreparationPort, private readonly library: PluginLibrary) {}
  accept(input: PluginContributionInput, signal: AbortSignal) {
    if (input.source === 'npm') assertPluginIdentity(input)
    return this.preparation.prepare(input, signal)
  }
  review(actor: CommunityAccountActor, row: MemberContribution, token: string): CommunitySkillPreview {
    this.artifact(row)
    const existing = this.library.list(actor).find(plugin => plugin.packageName === row.name)
    const impact = existing ? this.library.impact(actor, row.name) : { revision: 'new', groups: 0, members: 0, selectedMembers: 0 }
    return { name: row.name, description: row.description, markdown: row.markdown, files: row.files, token, revision: impact.revision, replacing: !!existing, managedMembers: impact.members, selectedMembers: impact.selectedMembers ?? 0 }
  }
  async confirm(actor: CommunityAccountActor, row: MemberContribution, preview: CommunitySkillPreview, committed: () => void): Promise<void> {
    await this.preparation.publish(this.artifact(row), (promoted, retained) => {
      this.library.adoptContribution(actor, promoted.candidate, promoted.prepared, preview.revision, { id: row.id, revision: row.revision, ...(promoted.checkedFor ? { checkedFor: promoted.checkedFor } : {}) }, () => { retained(); committed() })
    })
  }
  adopted(row: MemberContribution): boolean { return !!row.plugin && this.library.contributionAdopted(row.name, row.plugin.prepared.integrity) }
  collect(rows: readonly MemberContribution[]): Promise<void> { return this.preparation.recover(rows.flatMap(row => row.plugin ? [row.plugin] : [])) }
  private artifact(row: MemberContribution) { if (!row.plugin) throw new BusinessRuleError('missing', 'The plugin contribution is unavailable.', 'contribution-unavailable'); return row.plugin }
}
