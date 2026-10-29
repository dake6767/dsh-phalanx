import { BusinessRuleError } from '../domain/business-error.js'
import type { SuiteCatalogPluginItem } from '../domain/suite-catalog.js'
import type { PluginAccessAdministration } from './plugin-access-administration.js'
import type { PluginLibrary } from './plugin-library.js'
import type { PreparedSuitePlugin } from './suite-plugin-facts.js'

/** Coordinates the plugin and access owners inside the durable catalog transaction. */
export class SuitePlugins {
  constructor(
    private readonly library: PluginLibrary,
    private readonly access: PluginAccessAdministration,
  ) {}
  observeSuiteClaims(claims: () => readonly { packageName: string; origin: string }[]) {
    this.library.observeSuiteClaims(claims)
  }
  async assertSuiteAdmission(origin: string, packageName: string) {
    await this.library.assertSuiteAdmission(origin, packageName)
  }
  async suitePluginRow(origin: string) {
    return await this.library.suitePluginRow(origin)
  }
  async suitePluginConflicts(origin: string, packageName: string) {
    return await this.library.suitePluginConflicts(origin, packageName)
  }
  async suitePluginReplaceable(packageName: string) {
    return await this.library.suitePluginReplaceable(packageName)
  }
  async suitePluginImpact(origin: string) {
    return await this.library.suitePluginImpact(origin)
  }
  async suitePluginAccess(origin: string) {
    const row = await this.suitePluginRow(origin)
    return row ? await this.access.suiteSettings(row.packageName) : undefined
  }
  async prepareCatalogPlugin(
    origin: string,
    item: SuiteCatalogPluginItem,
    log: (line: string) => Promise<void>,
    signal: AbortSignal,
    expectedRevision?: string,
  ): Promise<PreparedSuitePlugin> {
    if (expectedRevision !== undefined && (await this.library.suitePluginReplaceable(item.packageName))?.revision !== expectedRevision)
      throw new BusinessRuleError('conflict', 'The plugin changed after confirmation.', 'suite-replace-unconfirmed')
    const accessRevision = (await this.access.suiteSettings(item.packageName))?.revision ?? 'none'
    const prepared = await this.library.prepareSuitePlugin(origin, item, log, signal)
    await this.access.validateSuiteTemplate(prepared, item.access, [...item.runtimeDependencies, ...item.catalogDependencies])
    return { item: structuredClone(item), prepared, accessRevision }
  }
  async discardSuitePlugin(origin: string) {
    this.library.discardSuitePlugin(origin)
  }
}
