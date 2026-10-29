import { BusinessRuleError } from '../domain/business-error.js'
import { pluginAccessIdentity } from '../domain/plugin-access.js'
import {
  assertPreparedPlugin,
  pluginCatalogRevision,
  pluginIdentities,
  PluginPreparationError,
  type LibraryPlugin,
  type PluginCandidate,
} from '../domain/plugin-library.js'
import type { PluginAccessStorePort } from '../ports/plugin-access.js'
import type { PluginLibraryMembershipPort, PluginLibraryStorePort, PluginPreparerPort } from '../ports/plugin-library.js'
import type { KeyedOperations } from './support/keyed-operations.js'

/** Catalog owns staging and origin policy, using the library's package queue and lifecycle. */
export class PluginLibraryCatalog {
  private readonly suiteStaged = new Map<string, import('../domain/plugin-library.js').PreparedPlugin>()
  constructor(
    private readonly store: PluginLibraryStorePort,
    private readonly preparer: PluginPreparerPort,
    private readonly membership: PluginLibraryMembershipPort | undefined,
    private readonly settings: { readonly access: Partial<Pick<PluginAccessStorePort, 'get'>> } | undefined,
    private readonly compatibilityTarget: string | undefined,
    private readonly operations: KeyedOperations,
    private readonly owner: {
      stopped(): boolean
      preparing(name: string): boolean
      claims(): readonly { packageName: string; origin: string }[]
      assertIdle(name: string): void
      remove(name: string): Promise<void>
    },
  ) {}
  async assertSuiteAdmission(origin: string, packageName: string): Promise<void> {
    this.owner.assertIdle(packageName)
    if (this.owner.claims().some(row => row.packageName === packageName && row.origin !== origin))
      throw new BusinessRuleError('conflict', 'Another catalog task holds this package.', 'plugin-job-busy')
    const row = (await this.store.list()).find(row => row.packageName === packageName)
    if (row?.removing) throw new BusinessRuleError('conflict', 'Plugin removal is pending.', 'plugin-job-busy')
    if (row?.suiteOrigin && row.suiteOrigin !== origin) throw new BusinessRuleError('conflict', 'Another catalog owns this plugin.', 'plugin-name-in-use')
  }
  /** Suite catalog seams: one catalog origin at a time prepares and commits a plugin row under that origin. */
  async suitePluginRow(origin: string): Promise<LibraryPlugin | undefined> {
    const row = (await this.store.list()).find(row => row.suiteOrigin === origin)
    return row ? structuredClone(row) : undefined
  }
  /** Same-package rows another catalog origin owns; they conflict with this entry. */
  async suitePluginConflicts(origin: string, packageName: string): Promise<readonly string[]> {
    const row = (await this.store.list()).find(row => row.packageName === packageName)
    return (row?.suiteOrigin && row.suiteOrigin !== origin) ||
      this.owner.preparing(packageName) ||
      this.owner.claims().some(claim => claim.packageName === packageName && claim.origin !== origin)
      ? [packageName]
      : []
  }
  /** The manual row a confirmed catalog install takes over in place. */
  async suitePluginReplaceable(packageName: string): Promise<{ readonly row: LibraryPlugin; readonly revision: string } | undefined> {
    const row = (await this.store.list()).find(row => row.packageName === packageName && !row.suiteOrigin)
    return row
      ? { row: structuredClone(row), revision: pluginCatalogRevision(row, (await this.settings?.access.get?.(packageName))?.revision ?? 'none') }
      : undefined
  }
  async suitePluginImpact(
    origin: string,
  ): Promise<{ name: string; groups: readonly { id: string; name: string }[]; published: boolean; selectedMembers: number } | undefined> {
    const row = (await this.store.list()).find(row => row.suiteOrigin === origin)
    if (!row) return undefined
    return {
      name: row.packageName,
      groups: (await this.membership?.impactGroups?.(row.packageName)) ?? [],
      published: row.published,
      selectedMembers: (await this.membership?.impact(row.packageName))?.selectedMembers ?? 0,
    }
  }
  /** Prepares the locked package under a catalog origin; nothing is written until commitSuitePlugin. */
  async prepareSuitePlugin(
    origin: string,
    item: { readonly packageName: string; readonly version: string; readonly integrity: string },
    log: (line: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<import('../domain/plugin-library.js').PreparedPlugin> {
    if (this.owner.stopped()) throw new BusinessRuleError('conflict', 'Plugin preparation is stopping.', 'plugin-job-interrupted')
    await this.assertSuiteAdmission(origin, item.packageName)
    const holder = (await this.store.list()).find(row => row.packageName === item.packageName)
    if (holder?.suiteOrigin && holder.suiteOrigin !== origin)
      throw new BusinessRuleError('conflict', 'This package is already in the library.', 'plugin-name-in-use')
    const known = holder ? pluginIdentities(holder)[item.version] : undefined
    await log(`Preparing plugin ${item.packageName}@${item.version}…`)
    const candidate: PluginCandidate = { packageName: item.packageName, version: item.version }
    const prepared = await this.preparer.prepare(candidate, async () => {}, signal)
    signal.throwIfAborted()
    await this.assertSuiteAdmission(origin, item.packageName)
    assertPreparedPlugin(candidate, prepared, known)
    // The catalog lock decides the bytes: whatever npm serves must hash to the signed integrity.
    if (prepared.integrity !== item.integrity) throw new PluginPreparationError('plugin-integrity-invalid')
    this.suiteStaged.set(origin, prepared)
    return structuredClone(prepared)
  }
  /** Writes the plugin row in place, keeping publication, grants and settings that follow the package name; `takeover` is the confirmed manual row (or, on update, the row this origin already owns). */
  async commitSuitePlugin(
    origin: string,
    item: {
      readonly packageName: string
      readonly version: string
      readonly integrity: string
      readonly access: import('../domain/admin-contract.js').CommunityPluginAccessInput
    },
    prepared: import('../domain/plugin-library.js').PreparedPlugin,
    runtimeDependencies: readonly string[],
    takeover?: LibraryPlugin,
  ): Promise<LibraryPlugin> {
    return await this.operations.run(item.packageName, async () => {
      await this.assertSuiteAdmission(origin, item.packageName)
      const staged = this.suiteStaged.get(origin)
      if (!staged || staged.integrity !== prepared.integrity || staged.packageName !== item.packageName)
        throw new BusinessRuleError('conflict', 'This plugin was not prepared for this task.', 'suite-catalog-invalid')
      this.suiteStaged.delete(origin)
      const current = (await this.store.list()).find(row => row.packageName === item.packageName)
      if (current && current.suiteOrigin !== origin) {
        // A row the plan did not confirm, or one that changed after the preview, refuses the takeover.
        if (!takeover || takeover.suiteOrigin || current.version !== takeover.version || current.current?.integrity !== takeover.current?.integrity)
          throw new BusinessRuleError('conflict', 'The manual plugin changed after the preview. Review the install again.', 'suite-replace-unconfirmed')
      }
      const provenance = current?.provenance ?? takeover?.provenance
      const { upload, replacement, failureCode, incompatible, restorePublication, retainedIntegrity, ...metadata } = current ?? {}
      void upload
      void replacement
      void failureCode
      void incompatible
      void restorePublication
      void retainedIntegrity
      const row: LibraryPlugin = {
        ...metadata,
        packageName: item.packageName,
        version: item.version,
        runtimeDependencies: [...runtimeDependencies],
        suiteOrigin: origin,
        suiteAppliedAccess: pluginAccessIdentity(item.access),
        ...(provenance ? { provenance } : {}),
        current: prepared,
        stage: 'available',
        published: current?.published === true || current?.restorePublication === true,
        identities: { ...pluginIdentities(current ?? takeover), [item.version]: item.integrity },
        ...(this.compatibilityTarget ? { checkedFor: this.compatibilityTarget } : {}),
      }
      await this.store.save(row)
      return structuredClone(row)
    })
  }
  /** Puts back the row a failed or interrupted task replaced, touching only rows this origin still owns. */
  async restoreSuitePlugin(origin: string, snapshot: { readonly row: LibraryPlugin }): Promise<void> {
    return await this.operations.run(snapshot.row.packageName, async () => {
      const current = (await this.store.list()).find(row => row.packageName === snapshot.row.packageName)
      if (!current || current.suiteOrigin !== origin) return
      await this.store.save({ ...structuredClone(snapshot.row), ...(current.revision !== undefined ? { revision: current.revision } : {}) })
    })
  }
  async dropSuitePluginRow(origin: string, packageName: string): Promise<void> {
    return await this.operations.run(packageName, async () => {
      if ((await this.store.list()).some(row => row.packageName === packageName && row.suiteOrigin === origin)) await this.owner.remove(packageName)
    })
  }
  async restoreSuiteAccessBaseline(origin: string, baseline?: string): Promise<void> {
    const row = await this.suitePluginRow(origin)
    if (row)
      await this.operations.run(row.packageName, async () => {
        const current = await this.suitePluginRow(origin)
        if (current?.packageName === row.packageName) await this.store.save({ ...current, ...(baseline !== undefined ? { suiteAppliedAccess: baseline } : {}) })
      })
  }
  discardSuitePlugin(origin: string): void {
    this.suiteStaged.delete(origin)
  }
  /** Removes the plugin rows this origin owns, with their grants, selections, access settings, checkpoints and upstreams. */
  async removeSuitePlugin(origin: string): Promise<void> {
    for (const row of (await this.store.list()).filter(row => row.suiteOrigin === origin))
      await this.operations.run(row.packageName, async () => {
        if (!(await this.store.list()).some(current => current.packageName === row.packageName && current.suiteOrigin === origin)) return
        await this.owner.remove(row.packageName)
      })
    this.suiteStaged.delete(origin)
  }
  /** Detaching keeps the plugin, its settings, grants and publication; only the catalog ownership goes. */
  async detachSuitePlugin(origin: string, packageName: string): Promise<void> {
    return await this.operations.run(packageName, async () => {
      const row = (await this.store.list()).find(row => row.packageName === packageName && row.suiteOrigin === origin)
      if (!row) return
      const { suiteOrigin, suiteAppliedAccess, ...detached } = row
      void suiteOrigin
      void suiteAppliedAccess
      await this.store.save(detached)
    })
  }
}
