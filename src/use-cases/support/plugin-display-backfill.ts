import type { LibraryPlugin, PreparedPlugin } from '../../domain/plugin-library.js'
import type { SuiteCatalogEntry } from '../../domain/suite-catalog.js'
import { suiteInstallOrigin } from '../../domain/suite-install.js'
import { BusinessRuleError } from '../../domain/business-error.js'
import type { PluginLibraryStorePort, PluginPreparerPort } from '../../ports/plugin-library.js'
import type { KeyedOperations } from './keyed-operations.js'

function needsMetadata(plugin: PreparedPlugin | null | undefined): plugin is PreparedPlugin {
  return Boolean(plugin && plugin.meta === undefined)
}

export async function backfillPluginMetadata(
  store: PluginLibraryStorePort,
  preparer: PluginPreparerPort,
  operations: KeyedOperations,
): Promise<readonly LibraryPlugin[]> {
  const rows = await store.list()
  const readMetadata = preparer.readDisplayMetadata?.bind(preparer)
  if (!readMetadata) return rows
  const pending = (row: LibraryPlugin) => needsMetadata(row.current) || needsMetadata(row.replacement?.prepared)
  if (!rows.some(pending)) return rows
  const read = async (plugin: PreparedPlugin) => {
    try {
      return { ...plugin, meta: await readMetadata(plugin) }
    } catch {
      console.warn(`Could not restore plugin display metadata for ${plugin.packageName}.`)
      return plugin
    }
  }
  for (const pendingRow of rows.filter(pending)) {
    await operations.run(pendingRow.packageName, async () => {
      const row = (await store.list()).find(candidate => candidate.packageName === pendingRow.packageName)
      if (!row || !pending(row)) return
      const current = needsMetadata(row.current) ? await read(row.current) : row.current
      const replacement = row.replacement
      const prepared = needsMetadata(replacement?.prepared) ? await read(replacement.prepared) : replacement?.prepared
      if (current === row.current && prepared === replacement?.prepared) return
      await saveBackfill(store, { ...row, current, ...(replacement ? { replacement: { ...replacement, prepared: prepared ?? null } } : {}) })
    })
  }
  return store.list()
}

export async function backfillPluginCatalogDefaults(
  store: PluginLibraryStorePort,
  operations: KeyedOperations,
  entries: readonly SuiteCatalogEntry[],
): Promise<void> {
  const catalog = new Map(entries.filter(entry => entry.category === 'plugin' && !entry.unavailableReason).map(entry => [suiteInstallOrigin(entry.id), entry]))
  if (!catalog.size) return
  for (const pending of await store.list()) {
    if (!pending.suiteOrigin || pending.display?.catalogDefaults || !catalog.has(pending.suiteOrigin)) continue
    await operations.run(pending.packageName, async () => {
      const row = (await store.list()).find(candidate => candidate.packageName === pending.packageName)
      if (!row?.suiteOrigin || row.display?.catalogDefaults) return
      const entry = catalog.get(row.suiteOrigin)
      if (!entry?.items.some(item => item.kind === 'plugin' && item.packageName === row.packageName)) return
      const { title, description } = entry
      await saveBackfill(store, { ...row, display: { ...row.display, catalogDefaults: { title, description } } })
    })
  }
}

async function saveBackfill(store: PluginLibraryStorePort, row: LibraryPlugin): Promise<void> {
  try {
    await store.save(row)
  } catch (error) {
    if (!(error instanceof BusinessRuleError) || error.code !== 'platform-configuration-conflict') throw error
    // Another writer changed the record; a later read can complete the backfill against the new revision.
  }
}
