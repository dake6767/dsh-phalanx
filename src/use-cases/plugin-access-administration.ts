import type { CommunityPluginAccessInput, CommunityPluginAccessView } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import { pluginAccessView } from '../domain/plugin-access-presentation.js'
import { mergePluginAccessInput, pluginAccessConfiguration, pluginAccessReferences } from '../domain/plugin-access.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginAccessStorePort, PluginAccessSyntaxPort } from '../ports/plugin-access.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginUpstreamReferencesPort, PluginUpstreamsPort } from '../ports/plugin-upstreams.js'

/** One owner for access validation, reference discovery and administrator projection. */
export class PluginAccessAdministration implements PluginUpstreamReferencesPort {
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly library: Pick<PluginLibraryStorePort, 'list'>,
    private readonly store: PluginAccessStorePort,
    private readonly upstreams: Pick<PluginUpstreamsPort, 'list'>,
    private readonly syntax: PluginAccessSyntaxPort,
  ) {}
  async view(actor: CommunityAccountActor, packageName: string): Promise<CommunityPluginAccessView> {
    await this.assertAdmin(actor, packageName)
    const settings = await this.store.get(packageName),
      entryIds = await this.entryIds(packageName)
    return pluginAccessView(settings, entryIds)
  }
  async summary(packageName: string) {
    const settings = await this.store.get(packageName),
      entryIds = settings ? await this.entryIds(packageName) : []
    return {
      accessConfigured: !!settings,
      invalidAccessEntries: Object.keys(settings?.entries ?? {}).filter(id => !entryIds.includes(id)),
      hasPlatformCredential: (await this.upstreams.list(packageName)).some(row => row.credential.length > 0),
    }
  }
  async save(actor: CommunityAccountActor, packageName: string, input: CommunityPluginAccessInput): Promise<CommunityPluginAccessView> {
    await this.assertAdmin(actor, packageName)
    const occupied = new Set(
      Object.entries(await this.store.list())
        .filter(([name]) => name !== packageName)
        .flatMap(([, settings]) => settings.environment.map(row => row.name)),
    )
    const previous = await this.store.get(packageName)
    const merged = mergePluginAccessInput(input, previous, source => this.syntax.parse(source))
    const { entries } = pluginAccessConfiguration(
      merged,
      source => this.syntax.parse(source),
      await this.entryIds(packageName),
      occupied,
      new Set((await this.upstreams.list(packageName)).map(row => row.name)),
      await this.dependencies(packageName),
    )
    if (!merged.environment.length && !Object.keys(entries).length) await this.store.remove(packageName, previous?.revision ?? 'none')
    else
      await this.store.save(packageName, { environment: merged.environment, entriesYaml: merged.entriesYaml, entries }, undefined, previous?.revision ?? 'none')
    return await this.view(actor, packageName)
  }
  async references(packageName: string, upstreamName: string): Promise<readonly string[]> {
    const settings = await this.store.get(packageName)
    return settings
      ? pluginAccessReferences(settings)
          .filter(row => row.name === upstreamName)
          .map(row => row.location)
      : []
  }
  async validateSuiteTemplate(prepared: PreparedPlugin, input: CommunityPluginAccessInput, dependencies: readonly string[]) {
    const occupied = new Set(
      Object.entries(await this.store.list())
        .filter(([name]) => name !== prepared.packageName)
        .flatMap(([, settings]) => settings.environment.map(row => row.name)),
    )
    return pluginAccessConfiguration(
      input,
      source => this.syntax.parse(source),
      this.syntax.entryIds(prepared),
      occupied,
      new Set((await this.upstreams.list(prepared.packageName)).map(row => row.name)),
      new Set(dependencies),
    )
  }
  async suiteSettings(packageName: string) {
    return await this.store.get(packageName)
  }
  async applySuiteTemplate(task: string, prepared: PreparedPlugin, input: CommunityPluginAccessInput, dependencies: readonly string[]): Promise<void> {
    const checked = await this.validateSuiteTemplate(prepared, input, dependencies)
    if (!this.store.applySuite) throw new BusinessRuleError('conflict', 'Plugin access checkpoints are unavailable.', 'plugin-access-invalid')
    await this.store.applySuite(prepared.packageName, task, checked)
  }
  async restoreSuiteTemplate(task: string, packageName: string): Promise<void> {
    if ((await this.store.restoreSuite?.(packageName, task)) === false)
      throw new BusinessRuleError('conflict', 'Plugin settings changed during recovery.', 'plugin-impact-changed')
  }
  async clearSuiteTemplate(task: string, packageName: string): Promise<void> {
    await this.store.clearSuiteCheckpoint?.(packageName, task)
  }
  private async dependencies(packageName: string) {
    return new Set((await this.library.list()).find(row => row.packageName === packageName)?.runtimeDependencies ?? [])
  }
  private async entryIds(packageName: string) {
    const plugin = (await this.library.list()).find(row => row.packageName === packageName)?.current
    return plugin ? this.syntax.entryIds(plugin) : []
  }
  async contributionRevision(packageName: string) {
    return (await this.store.get(packageName))?.revision ?? 'none'
  }
  async contributionApplied(packageName: string, receipt: ContributionReceipt) {
    const current = await this.store.receipt?.(packageName)
    return current?.id === receipt.id && current.revision === receipt.revision
  }
  async skipContribution(packageName: string, receipt: ContributionReceipt, warnings: readonly string[]): Promise<readonly string[]> {
    if (await this.contributionApplied(packageName, receipt)) return (await this.store.receipt?.(packageName))?.warnings ?? []
    const current = await this.store.get(packageName)
    if (!this.store.commitContribution) throw new BusinessRuleError('conflict', 'Review changed plugin settings.', 'plugin-impact-changed')
    await this.store.commitContribution(
      packageName,
      current ? { environment: current.environment, entriesYaml: current.entriesYaml, entries: current.entries } : undefined,
      { ...receipt, warnings },
    )
    return warnings
  }
  async contributionView(actor: CommunityAccountActor, prepared: PreparedPlugin): Promise<CommunityPluginAccessView> {
    await this.assertActor(actor)
    const settings = await this.store.get(prepared.packageName),
      entryIds = this.syntax.entryIds(prepared)
    return pluginAccessView(settings, entryIds)
  }
  async validateContribution(actor: CommunityAccountActor, prepared: PreparedPlugin, input: CommunityPluginAccessInput, upstreams: readonly string[]) {
    await this.assertActor(actor)
    return await this.checkContribution(prepared, input, upstreams)
  }
  private async checkContribution(prepared: PreparedPlugin, input: CommunityPluginAccessInput, upstreams: readonly string[]) {
    const occupied = new Set(
      Object.entries(await this.store.list())
        .filter(([name]) => name !== prepared.packageName)
        .flatMap(([, settings]) => settings.environment.map(row => row.name)),
    )
    return pluginAccessConfiguration(
      mergePluginAccessInput(input, await this.store.get(prepared.packageName), source => this.syntax.parse(source)),
      source => this.syntax.parse(source),
      this.syntax.entryIds(prepared),
      occupied,
      new Set(upstreams),
      await this.dependencies(prepared.packageName),
    )
  }
  /** Apply a validated contribution draft through the caller repositories; browser writes use save(). */
  async adoptContribution(prepared: PreparedPlugin, input: CommunityPluginAccessInput, receipt: ContributionReceipt): Promise<readonly string[]> {
    if (!(await this.library.list()).some(row => row.packageName === prepared.packageName && !row.removing))
      throw new BusinessRuleError('missing', 'Plugin was not found', 'not-found')
    const applied = await this.store.receipt?.(prepared.packageName)
    if (applied?.id === receipt.id && applied.revision === receipt.revision) return applied.warnings ?? []
    let checked
    try {
      checked = await this.checkContribution(
        prepared,
        input,
        (await this.upstreams.list(prepared.packageName)).map(row => row.name),
      )
    } catch (error) {
      if (!(error instanceof BusinessRuleError) || error.code !== 'plugin-access-invalid') throw error
      const warnings = ['Plugin access settings changed during adoption. Review configuration before publishing or granting this plugin.']
      const current = await this.store.get(prepared.packageName)
      if (!this.store.commitContribution) throw error
      await this.store.commitContribution(
        prepared.packageName,
        current ? { environment: current.environment, entriesYaml: current.entriesYaml, entries: current.entries } : undefined,
        { ...receipt, warnings },
      )
      return warnings
    }
    const settings = checked.environment.length || Object.keys(checked.entries).length ? checked : undefined
    if (this.store.commitContribution) await this.store.commitContribution(prepared.packageName, settings, receipt)
    else if (settings) await this.store.save(prepared.packageName, settings, receipt)
    else await this.store.remove(prepared.packageName)
    return []
  }
  private async assertAdmin(actor: CommunityAccountActor, packageName: string) {
    await this.assertActor(actor)
    if (!(await this.library.list()).some(row => row.packageName === packageName && !row.removing))
      throw new BusinessRuleError('missing', 'Plugin was not found', 'not-found')
  }
  private async assertActor(actor: CommunityAccountActor) {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
