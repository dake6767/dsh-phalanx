import { BusinessRuleError } from '../domain/business-error.js'
import { pluginAccessIdentity } from '../domain/plugin-access.js'
import {
  assertPreparedPlugin,
  pluginCatalogRevision,
  pluginIdentities,
  PluginPreparationError,
  type LibraryPlugin,
  type PreparedPlugin,
} from '../domain/plugin-library.js'
import type { SuiteCatalogPluginItem } from '../domain/suite-catalog.js'
import { readyRuntimeDependencies } from '../domain/runtime-dependency-selection.js'
import type { PluginAccessSyntaxPort } from '../ports/plugin-access.js'
import type { SuiteRepositories } from '../ports/suite-unit-of-work.js'
import { PluginAccessAdministration } from './plugin-access-administration.js'
import { resolvedPluginItem } from './suite-entry-kinds.js'

export interface PreparedSuitePlugin {
  readonly item: SuiteCatalogPluginItem
  readonly prepared: PreparedPlugin
  readonly accessRevision: string
}

/** Parent and settings are read after the catalog acquired their locks; no checkpoint or external preparation is written here. */
export async function writeSuitePlugin(
  rows: Pick<SuiteRepositories, 'accounts' | 'plugins' | 'pluginAccess' | 'pluginUpstreams' | 'runtime'>,
  origin: string,
  plan: PreparedSuitePlugin,
  dependencies: readonly string[],
  mode: 'install' | 'update',
  syntax: PluginAccessSyntaxPort,
  policy: { readonly compatibilityTarget?: string; readonly takeover?: { readonly row: LibraryPlugin; readonly revision: string } } = {},
): Promise<LibraryPlugin> {
  const { compatibilityTarget, takeover } = policy
  const item = resolvedPluginItem(plan.item, dependencies),
    current = (await rows.plugins.list()).find(row => row.packageName === item.packageName),
    settings = await rows.pluginAccess.get(item.packageName)
  if (current?.removing || (current?.suiteOrigin && current.suiteOrigin !== origin) || (mode === 'update' && current?.suiteOrigin !== origin))
    throw new BusinessRuleError('conflict', 'The installed plugin identity changed.', 'plugin-name-in-use')
  if (mode === 'install') {
    if ((settings?.revision ?? 'none') !== plan.accessRevision)
      throw new BusinessRuleError('conflict', 'Plugin access settings changed during preparation.', 'plugin-impact-changed')
    if ((current && current.suiteOrigin !== origin) || (!current && takeover)) {
      if (!current || !takeover || takeover.row.suiteOrigin || pluginCatalogRevision(current, settings?.revision ?? 'none') !== takeover.revision)
        throw new BusinessRuleError('conflict', 'The manual plugin changed after the preview. Review the install again.', 'suite-replace-unconfirmed')
    }
  }
  assertPreparedPlugin({ packageName: item.packageName, version: item.version }, plan.prepared, pluginIdentities(current)[item.version])
  if (plan.prepared.integrity !== item.integrity) throw new PluginPreparationError('plugin-integrity-invalid')
  readyRuntimeDependencies(await rows.runtime.list(), dependencies)
  const modified = mode === 'update' && current?.suiteAppliedAccess !== pluginAccessIdentity(settings ?? { environment: [], entriesYaml: '' }),
    access = new PluginAccessAdministration(rows.accounts, rows.plugins, rows.pluginAccess, rows.pluginUpstreams, syntax),
    checked = await access.validateSuiteTemplate(plan.prepared, modified ? (settings ?? { environment: [], entriesYaml: '' }) : item.access, dependencies)
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
    runtimeDependencies: [...dependencies],
    suiteOrigin: origin,
    ...(modified ? {} : { suiteAppliedAccess: pluginAccessIdentity(item.access) }),
    current: plan.prepared,
    stage: 'available',
    published: current?.published === true || current?.restorePublication === true,
    identities: { ...pluginIdentities(current), [item.version]: item.integrity },
    ...(compatibilityTarget ? { checkedFor: compatibilityTarget } : {}),
  }
  await rows.plugins.save(row, current?.revision ?? 'none')
  if (!modified) await rows.pluginAccess.save(item.packageName, checked, undefined, settings?.revision ?? 'none')
  return row
}
