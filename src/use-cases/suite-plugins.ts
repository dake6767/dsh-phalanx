import { BusinessRuleError } from '../domain/business-error.js'
import { pluginAccessIdentity } from '../domain/plugin-access.js'
import type { LibraryPlugin, PreparedPlugin } from '../domain/plugin-library.js'
import type { SuiteCatalogPluginItem } from '../domain/suite-catalog.js'
import type { PluginLibrary } from './plugin-library.js'
import type { PluginAccessAdministration } from './plugin-access-administration.js'

/** Coordinates the plugin and access owners inside the durable catalog transaction. */
export class SuitePlugins {
  private readonly revisions = new Map<string, string>()
  constructor(private readonly library: PluginLibrary, private readonly access: PluginAccessAdministration) {}
  observeSuiteClaims(claims: () => readonly { packageName: string, origin: string }[]) { this.library.observeSuiteClaims(claims) }
  assertSuiteAdmission(origin: string, packageName: string) { this.library.assertSuiteAdmission(origin, packageName) }
  suitePluginRow(origin: string) { return this.library.suitePluginRow(origin) }
  suitePluginConflicts(origin: string, packageName: string) { return this.library.suitePluginConflicts(origin, packageName) }
  suitePluginReplaceable(packageName: string) { return this.library.suitePluginReplaceable(packageName) }
  suitePluginImpact(origin: string) { return this.library.suitePluginImpact(origin) }
  suitePluginAccess(origin: string) { const row = this.suitePluginRow(origin); return row ? this.access.suiteSettings(row.packageName) : undefined }
  async prepareSuitePlugin(origin: string, item: SuiteCatalogPluginItem, log: (line: string) => Promise<void>, signal: AbortSignal, expectedRevision?: string) {
    if (expectedRevision !== undefined && this.library.suitePluginReplaceable(item.packageName)?.revision !== expectedRevision) throw new BusinessRuleError('conflict', 'The plugin changed after confirmation.', 'suite-replace-unconfirmed')
    this.revisions.set(origin, this.access.suiteSettings(item.packageName)?.revision ?? 'none')
    const prepared = await this.library.prepareSuitePlugin(origin, item, log, signal)
    this.access.validateSuiteTemplate(prepared, item.access, [...item.runtimeDependencies, ...item.catalogDependencies])
    return prepared
  }
  async commitSuitePlugin(origin: string, item: SuiteCatalogPluginItem, prepared: PreparedPlugin, dependencies: readonly string[], takeover?: LibraryPlugin) {
    if ((this.access.suiteSettings(item.packageName)?.revision ?? 'none') !== this.revisions.get(origin)) throw new BusinessRuleError('conflict', 'Plugin access settings changed during preparation.', 'plugin-impact-changed')
    this.access.applySuiteTemplate(origin, prepared, item.access, dependencies)
    this.library.commitSuitePlugin(origin, item, prepared, dependencies, takeover)
  }
  async updateSuitePlugin(origin: string, item: SuiteCatalogPluginItem, prepared: PreparedPlugin, dependencies: readonly string[]) {
    const row = this.suitePluginRow(origin)
    if (!row || row.packageName !== item.packageName) throw new BusinessRuleError('conflict', 'The installed plugin identity changed.', 'plugin-name-in-use')
    const settings = this.access.suiteSettings(row.packageName)
    const modified = row.suiteAppliedAccess !== pluginAccessIdentity(settings ?? { environment: [], entriesYaml: '' })
    if (modified) this.access.validateSuiteTemplate(prepared, settings ?? { environment: [], entriesYaml: '' }, dependencies)
    if (!modified) this.access.applySuiteTemplate(origin, prepared, item.access, dependencies)
    this.library.commitSuitePlugin(origin, modified ? { ...item, access: settings ?? { environment: [], entriesYaml: '' } } : item, prepared, dependencies, row)
    // A skipped template does not advance the last-applied baseline.
    if (modified) this.library.restoreSuiteAccessBaseline(origin, row.suiteAppliedAccess)
  }
  async restoreSuitePlugin(origin: string, snapshot: { readonly row: LibraryPlugin } | { readonly packageName: string }): Promise<boolean> {
    if ('row' in snapshot) this.library.restoreSuitePlugin(origin, snapshot)
    else this.library.dropSuitePluginRow(origin, snapshot.packageName)
    this.access.restoreSuiteTemplate(origin, 'row' in snapshot ? snapshot.row.packageName : snapshot.packageName)
    return true
  }
  async discardSuitePlugin(origin: string) { this.revisions.delete(origin); this.library.discardSuitePlugin(origin) }
  async removeSuitePlugin(origin: string) { this.library.removeSuitePlugin(origin) }
  async detachSuitePlugin(origin: string, name: string) { this.library.detachSuitePlugin(origin, name); this.access.clearSuiteTemplate(origin, name) }
  async settleSuitePlugin(origin: string) { this.revisions.delete(origin); const row = this.suitePluginRow(origin); if (row) this.access.clearSuiteTemplate(origin, row.packageName) }
}
