import type { CommunityAccountActor } from '../domain/community-account.js'
import type { ContributionSetup, MemberContribution } from '../domain/member-contribution.js'
import type { PluginContributionAdministrationPort, PluginContributionDistributionPort } from '../ports/plugin-contribution-administration.js'
import type { PluginAccessSyntaxPort } from '../ports/plugin-access.js'
import type { PluginAccessAdministration } from './plugin-access-administration.js'
import type { PluginUpstreamAdministration } from './plugin-upstream-administration.js'
import type { PluginUpstreamTest } from './plugin-upstream-test.js'
import { pluginContributionPrefill } from '../domain/plugin-contribution-checks.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { upstreamInput } from '../domain/plugin-upstream.js'
import type { CommunityPluginUpstreamInput } from '../domain/admin-contract.js'

/** The contribution intent coordinates existing upstream, access and distribution owners. */
export class PluginContributionAdministration implements PluginContributionAdministrationPort {
  constructor(private readonly access: PluginAccessAdministration, private readonly upstreams: PluginUpstreamAdministration, private readonly syntax: PluginAccessSyntaxPort, private readonly distribution?: PluginContributionDistributionPort, private readonly upstreamTest?: PluginUpstreamTest) {}
  preview(actor: CommunityAccountActor, row: MemberContribution) {
    const prepared = this.prepared(row), declaration = row.declaration.plugin ?? { upstreams: [], environment: [], entriesYaml: '' }
    const plugin = pluginContributionPrefill(declaration, this.syntax, this.access.contributionView(actor, prepared), this.upstreams.contributionList(actor, row.name))
    return { plugin, configuration: this.configuration(row.name), ...(this.distribution ? { groups: this.distribution.groups(actor, row.name) } : {}) }
  }
  validate(actor: CommunityAccountActor, row: MemberContribution, setup?: ContributionSetup): void {
    if (setup !== undefined && (!setup || typeof setup !== 'object' || Array.isArray(setup) || Object.keys(setup).some(key => !['plugin', 'published', 'groups', 'credentialSharingConfirmed', 'maintenance', 'configuration'].includes(key)))) throw this.invalid()
    if (setup?.configuration && JSON.stringify(setup.configuration) !== JSON.stringify(this.configuration(row.name))) throw new BusinessRuleError('conflict', 'Review the newer plugin settings.', 'plugin-impact-changed')
    const input = setup?.plugin ?? this.preview(actor, row).plugin
    if (!input || !Array.isArray(input.upstreams) || input.upstreams.length > 128) throw this.invalid()
    for (const upstream of input.upstreams) upstreamInput(upstream)
    if (new Set(input.upstreams.map(row => row.name)).size !== input.upstreams.length) throw this.invalid()
    const existing = this.upstreams.contributionList(actor, row.name)
    this.access.validateContribution(actor, this.prepared(row), input.access, [...existing.map(row => row.name), ...input.upstreams.map(row => row.name)])
    for (const variable of row.declaration.plugin?.environment ?? []) if (variable.secret && input.access.environment.some(row => row.name === variable.name && row.value !== '{access-token}' && !/^\{upstream:[a-zA-Z0-9_-]{1,64}\}$/u.test(row.value))) throw new BusinessRuleError('invalid', 'Keep platform credentials in upstream settings and use {access-token} for member authentication.', 'plugin-access-invalid', { reason: 'credential' })
    if (setup?.published && [...existing, ...input.upstreams].some(upstream => ('credential' in upstream && !!upstream.credential) || ('hasCredential' in upstream && upstream.hasCredential)) && setup.credentialSharingConfirmed !== true) throw new BusinessRuleError('conflict', 'Confirm platform credential sharing', 'plugin-publication-credential-confirmation')
    this.distribution?.validate(actor, row.name, setup)
  }
  async apply(row: MemberContribution, setup?: ContributionSetup): Promise<readonly string[]> {
    if (setup?.plugin) {
      const receipt = { id: row.id, revision: row.revision }
      const expected = setup.configuration
      if (expected && (!this.upstreams.contributionApplied(row.name, receipt) && expected.upstreams !== this.upstreams.contributionRevision(row.name) || !this.access.contributionApplied(row.name, receipt) && expected.access !== this.access.contributionRevision(row.name))) {
        const warnings = ['Plugin settings changed during adoption. The newer administrator configuration was retained; review configuration before adding distribution choices.']
        this.upstreams.skipContribution(row.name, receipt, warnings); this.access.skipContribution(row.name, receipt, warnings); return warnings
      }
      const upstreamWarnings = this.upstreams.adoptContribution(row.name, setup.plugin.upstreams, receipt)
      if (upstreamWarnings.length) return this.access.skipContribution(row.name, receipt, upstreamWarnings)
      const warnings = this.access.adoptContribution(this.prepared(row), setup.plugin.access, receipt)
      if (warnings.length) return warnings
    }
    return this.distribution?.apply(row, setup) ?? []
  }
  test(actor: CommunityAccountActor, row: MemberContribution, input: CommunityPluginUpstreamInput) {
    if (!this.upstreamTest) throw new BusinessRuleError('conflict', 'Upstream testing is unavailable.', 'contribution-unavailable')
    this.prepared(row)
    return this.upstreamTest.preview(actor, row.name, input)
  }
  private configuration(packageName: string) { return { access: this.access.contributionRevision(packageName), upstreams: this.upstreams.contributionRevision(packageName) } }
  private prepared(row: MemberContribution) { if (!row.plugin) throw new BusinessRuleError('missing', 'Plugin contribution not found.', 'contribution-unavailable'); return row.plugin.prepared }
  private invalid() { return new BusinessRuleError('invalid', 'Review the plugin configuration before adoption.', 'contribution-invalid') }
}
