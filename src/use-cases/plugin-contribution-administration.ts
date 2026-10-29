import type { CommunityPluginUpstreamInput } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import type { ContributionSetup, MemberContribution } from '../domain/member-contribution.js'
import { pluginContributionPrefill } from '../domain/plugin-contribution-checks.js'
import { upstreamInput, upstreamWriteInput } from '../domain/plugin-upstream.js'
import type { PluginAccessSyntaxPort } from '../ports/plugin-access.js'
import type { PluginContributionAdministrationPort, PluginContributionDistributionPort } from '../ports/plugin-contribution-administration.js'
import type { PluginAccessAdministration } from './plugin-access-administration.js'
import type { PluginUpstreamAdministration } from './plugin-upstream-administration.js'
import type { PluginUpstreamTest } from './plugin-upstream-test.js'

/** Validates contribution plans and applies configuration through its injected owners. */
export class PluginContributionAdministration implements PluginContributionAdministrationPort {
  constructor(
    private readonly access: PluginAccessAdministration,
    private readonly upstreams: PluginUpstreamAdministration,
    private readonly syntax: PluginAccessSyntaxPort,
    private readonly distribution?: PluginContributionDistributionPort,
    private readonly upstreamTest?: PluginUpstreamTest,
  ) {}
  async preview(actor: CommunityAccountActor, row: MemberContribution) {
    const prepared = this.prepared(row),
      declaration = row.declaration.plugin ?? { upstreams: [], environment: [], entriesYaml: '' }
    const plugin = pluginContributionPrefill(
      declaration,
      this.syntax,
      await this.access.contributionView(actor, prepared),
      await this.upstreams.contributionList(actor, row.name),
    )
    return {
      plugin,
      configuration: await this.configuration(row.name),
      ...(this.distribution ? { groups: await this.distribution.groups(actor, row.name) } : {}),
    }
  }
  async validate(actor: CommunityAccountActor, row: MemberContribution, setup?: ContributionSetup): Promise<void> {
    if (
      setup !== undefined &&
      (!setup ||
        typeof setup !== 'object' ||
        Array.isArray(setup) ||
        Object.keys(setup).some(key => !['plugin', 'published', 'groups', 'credentialSharingConfirmed', 'maintenance', 'configuration'].includes(key)))
    )
      throw this.invalid()
    if (setup?.configuration && JSON.stringify(setup.configuration) !== JSON.stringify(await this.configuration(row.name)))
      throw new BusinessRuleError('conflict', 'Review the newer plugin settings.', 'plugin-impact-changed')
    const preview = setup?.plugin ? undefined : (await this.preview(actor, row)).plugin
    const input = setup?.plugin ?? {
      ...preview!,
      upstreams: preview!.upstreams.map(upstream =>
        upstreamWriteInput(
          upstream,
          row.declaration.plugin?.upstreams.find(item => item.name === upstream.name),
        ),
      ),
    }
    if (!input || !Array.isArray(input.upstreams) || input.upstreams.length > 128) throw this.invalid()
    for (const upstream of input.upstreams) upstreamInput(upstream)
    if (new Set(input.upstreams.map(row => row.name)).size !== input.upstreams.length) throw this.invalid()
    const existing = await this.upstreams.contributionList(actor, row.name)
    const checkedAccess = await this.access.validateContribution(actor, this.prepared(row), input.access, [
      ...existing.map(row => row.name),
      ...input.upstreams.map(row => row.name),
    ])
    for (const variable of row.declaration.plugin?.environment ?? [])
      if (
        variable.secret &&
        checkedAccess.environment.some(
          row => row.name === variable.name && row.value !== '{access-token}' && !/^\{upstream:[a-zA-Z0-9_-]{1,64}\}$/u.test(row.value),
        )
      )
        throw new BusinessRuleError(
          'invalid',
          'Keep platform credentials in upstream settings and use {access-token} for member authentication.',
          'plugin-access-invalid',
          { reason: 'credential' },
        )
    if (
      setup?.published &&
      (existing.some(upstream => upstream.credential.configured) || input.upstreams.some(upstream => !!upstream.credential)) &&
      setup.credentialSharingConfirmed !== true
    )
      throw new BusinessRuleError('conflict', 'Confirm platform credential sharing', 'plugin-publication-credential-confirmation')
    await this.distribution?.validate(actor, row.name, setup)
  }
  async apply(row: MemberContribution, setup?: ContributionSetup): Promise<readonly string[]> {
    if (setup?.plugin) {
      const receipt = { id: row.id, revision: row.revision }
      const expected = setup.configuration
      if (
        expected &&
        ((!(await this.upstreams.contributionApplied(row.name, receipt)) && expected.upstreams !== (await this.upstreams.contributionRevision(row.name))) ||
          (!(await this.access.contributionApplied(row.name, receipt)) && expected.access !== (await this.access.contributionRevision(row.name))))
      ) {
        const warnings = [
          'Plugin settings changed during adoption. The newer administrator configuration was retained; review configuration before adding distribution choices.',
        ]
        await this.upstreams.skipContribution(row.name, receipt, warnings)
        await this.access.skipContribution(row.name, receipt, warnings)
        return warnings
      }
      const upstreamWarnings = await this.upstreams.adoptContribution(row.name, setup.plugin.upstreams, receipt)
      if (upstreamWarnings.length) return this.access.skipContribution(row.name, receipt, upstreamWarnings)
      const warnings = await this.access.adoptContribution(this.prepared(row), setup.plugin.access, receipt)
      if (warnings.length) return warnings
    }
    return (await this.distribution?.apply(row, setup)) ?? []
  }
  test(actor: CommunityAccountActor, row: MemberContribution, input: CommunityPluginUpstreamInput) {
    if (!this.upstreamTest) throw new BusinessRuleError('conflict', 'Upstream testing is unavailable.', 'contribution-unavailable')
    this.prepared(row)
    return this.upstreamTest.preview(actor, row.name, input)
  }
  private async configuration(packageName: string) {
    return { access: await this.access.contributionRevision(packageName), upstreams: await this.upstreams.contributionRevision(packageName) }
  }
  private prepared(row: MemberContribution) {
    if (!row.plugin) throw new BusinessRuleError('missing', 'Plugin contribution not found.', 'contribution-unavailable')
    return row.plugin.prepared
  }
  private invalid() {
    return new BusinessRuleError('invalid', 'Review the plugin configuration before adoption.', 'contribution-invalid')
  }
}
