import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityPluginAccessInput, CommunityPluginAccessView } from '../domain/admin-contract.js'
import { pluginAccessConfiguration, pluginAccessReferences } from '../domain/plugin-access.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginAccessStorePort, PluginAccessSyntaxPort } from '../ports/plugin-access.js'
import type { PluginUpstreamsPort, PluginUpstreamReferencesPort } from '../ports/plugin-upstreams.js'

/** One owner for access validation, reference discovery and administrator projection. */
export class PluginAccessAdministration implements PluginUpstreamReferencesPort {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>, private readonly library: Pick<PluginLibraryStorePort, 'list'>,
    private readonly store: PluginAccessStorePort, private readonly upstreams: Pick<PluginUpstreamsPort, 'list'>, private readonly syntax: PluginAccessSyntaxPort) {}
  view(actor: CommunityAccountActor, packageName: string): CommunityPluginAccessView {
    this.assertAdmin(actor, packageName)
    const settings = this.store.get(packageName), entryIds = this.entryIds(packageName)
    return { environment: settings?.environment ?? [], entriesYaml: settings?.entriesYaml ?? '', configured: !!settings, entryIds,
      invalidEntryIds: Object.keys(settings?.entries ?? {}).filter(id => !entryIds.includes(id)) }
  }
  summary(packageName: string) {
    const settings = this.store.get(packageName), entryIds = settings ? this.entryIds(packageName) : []
    return { accessConfigured: !!settings, invalidAccessEntries: Object.keys(settings?.entries ?? {}).filter(id => !entryIds.includes(id)), hasPlatformCredential: this.upstreams.list(packageName).some(row => row.credential.length > 0) }
  }
  save(actor: CommunityAccountActor, packageName: string, input: CommunityPluginAccessInput): CommunityPluginAccessView {
    this.assertAdmin(actor, packageName)
    const occupied = new Set(Object.entries(this.store.list()).filter(([name]) => name !== packageName).flatMap(([, settings]) => settings.environment.map(row => row.name)))
    const { entries } = pluginAccessConfiguration(input, source => this.syntax.parse(source), this.entryIds(packageName), occupied, new Set(this.upstreams.list(packageName).map(row => row.name)), this.dependencies(packageName))
    if (!input.environment.length && !Object.keys(entries).length) this.store.remove(packageName)
    else this.store.save(packageName, { environment: input.environment, entriesYaml: input.entriesYaml, entries })
    return this.view(actor, packageName)
  }
  references(packageName: string, upstreamName: string): readonly string[] {
    const settings = this.store.get(packageName)
    return settings ? pluginAccessReferences(settings).filter(row => row.name === upstreamName).map(row => row.location) : []
  }
  validateSuiteTemplate(prepared: PreparedPlugin, input: CommunityPluginAccessInput, dependencies: readonly string[]) {
    const occupied = new Set(Object.entries(this.store.list()).filter(([name]) => name !== prepared.packageName).flatMap(([, settings]) => settings.environment.map(row => row.name)))
    return pluginAccessConfiguration(input, source => this.syntax.parse(source), this.syntax.entryIds(prepared), occupied, new Set(this.upstreams.list(prepared.packageName).map(row => row.name)), new Set(dependencies))
  }
  suiteSettings(packageName: string) { return this.store.get(packageName) }
  applySuiteTemplate(task: string, prepared: PreparedPlugin, input: CommunityPluginAccessInput, dependencies: readonly string[]): void {
    const checked = this.validateSuiteTemplate(prepared, input, dependencies)
    if (!this.store.applySuite) throw new BusinessRuleError('conflict', 'Plugin access checkpoints are unavailable.', 'plugin-access-invalid')
    this.store.applySuite(prepared.packageName, task, checked)
  }
  restoreSuiteTemplate(task: string, packageName: string): void {
    if (this.store.restoreSuite?.(packageName, task) === false) throw new BusinessRuleError('conflict', 'Plugin settings changed during recovery.', 'plugin-impact-changed')
  }
  clearSuiteTemplate(task: string, packageName: string): void { this.store.clearSuiteCheckpoint?.(packageName, task) }
  private dependencies(packageName: string) { return new Set(this.library.list().find(row => row.packageName === packageName)?.runtimeDependencies ?? []) }
  private entryIds(packageName: string) {
    const plugin = this.library.list().find(row => row.packageName === packageName)?.current
    return plugin ? this.syntax.entryIds(plugin) : []
  }
  contributionRevision(packageName: string) { return this.store.get(packageName)?.revision ?? 'none' }
  contributionApplied(packageName: string, receipt: ContributionReceipt) { const current = this.store.receipt?.(packageName); return current?.id === receipt.id && current.revision === receipt.revision }
  skipContribution(packageName: string, receipt: ContributionReceipt, warnings: readonly string[]): readonly string[] {
    if (this.contributionApplied(packageName, receipt)) return this.store.receipt?.(packageName)?.warnings ?? []
    const current = this.store.get(packageName)
    if (!this.store.commitContribution) throw new BusinessRuleError('conflict', 'Review changed plugin settings.', 'plugin-impact-changed')
    this.store.commitContribution(packageName, current ? { environment: current.environment, entriesYaml: current.entriesYaml, entries: current.entries } : undefined, { ...receipt, warnings })
    return warnings
  }
  contributionView(actor: CommunityAccountActor, prepared: PreparedPlugin): CommunityPluginAccessView {
    this.assertActor(actor)
    const settings = this.store.get(prepared.packageName), entryIds = this.syntax.entryIds(prepared)
    return { environment: settings?.environment ?? [], entriesYaml: settings?.entriesYaml ?? '', configured: !!settings, entryIds, invalidEntryIds: Object.keys(settings?.entries ?? {}).filter(id => !entryIds.includes(id)) }
  }
  validateContribution(actor: CommunityAccountActor, prepared: PreparedPlugin, input: CommunityPluginAccessInput, upstreams: readonly string[]) {
    this.assertActor(actor)
    return this.checkContribution(prepared, input, upstreams)
  }
  private checkContribution(prepared: PreparedPlugin, input: CommunityPluginAccessInput, upstreams: readonly string[]) {
    const occupied = new Set(Object.entries(this.store.list()).filter(([name]) => name !== prepared.packageName).flatMap(([, settings]) => settings.environment.map(row => row.name)))
    return pluginAccessConfiguration(input, source => this.syntax.parse(source), this.syntax.entryIds(prepared), occupied, new Set(upstreams), this.dependencies(prepared.packageName))
  }
  /** Replay an already authorized contribution intent; browser writes use save(). */
  adoptContribution(prepared: PreparedPlugin, input: CommunityPluginAccessInput, receipt: ContributionReceipt): readonly string[] {
    if (!this.library.list().some(row => row.packageName === prepared.packageName && !row.removing)) throw new BusinessRuleError('missing', 'Plugin was not found', 'not-found')
    const applied = this.store.receipt?.(prepared.packageName)
    if (applied?.id === receipt.id && applied.revision === receipt.revision) return applied.warnings ?? []
    let checked
    try { checked = this.checkContribution(prepared, input, this.upstreams.list(prepared.packageName).map(row => row.name)) }
    catch (error) {
      if (!(error instanceof BusinessRuleError) || error.code !== 'plugin-access-invalid') throw error
      const warnings = ['Plugin access settings changed during adoption. Review configuration before publishing or granting this plugin.']
      const current = this.store.get(prepared.packageName)
      if (!this.store.commitContribution) throw error
      this.store.commitContribution(prepared.packageName, current ? { environment: current.environment, entriesYaml: current.entriesYaml, entries: current.entries } : undefined, { ...receipt, warnings })
      return warnings
    }
    const settings = checked.environment.length || Object.keys(checked.entries).length ? checked : undefined
    if (this.store.commitContribution) this.store.commitContribution(prepared.packageName, settings, receipt)
    else if (settings) this.store.save(prepared.packageName, settings, receipt)
    else this.store.remove(prepared.packageName)
    return []
  }
  private assertAdmin(actor: CommunityAccountActor, packageName: string) {
    this.assertActor(actor)
    if (!this.library.list().some(row => row.packageName === packageName && !row.removing)) throw new BusinessRuleError('missing', 'Plugin was not found', 'not-found')
  }
  private assertActor(actor: CommunityAccountActor) {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
