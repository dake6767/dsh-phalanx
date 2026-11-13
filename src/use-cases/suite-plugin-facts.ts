import { installServiceDefinition, type InstalledServiceIdentity } from '../domain/installed-services.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { pluginAccessIdentity } from '../domain/plugin-access.js'
import {
  assertPreparedPlugin,
  pluginCatalogRevision,
  pluginIdentities,
  PluginPreparationError,
  type LibraryPlugin,
  type PreparedPlugin,
  npmPluginSource,
  uploadPluginSource,
} from '../domain/plugin-library.js'
import type { SuiteCatalogPluginItem } from '../domain/suite-catalog.js'
import { satisfiesSemverRange } from '../domain/semver.js'
import { readyRuntimeDependencies } from '../domain/runtime-dependency-selection.js'
import type { PluginAccessSyntaxPort } from '../ports/plugin-access.js'
import type { SuiteRepositories } from '../ports/suite-unit-of-work.js'
import { PluginAccessAdministration } from './plugin-access-administration.js'
import { resolvedPluginItem } from './suite-entry-kinds.js'

export function assertCatalogPluginBindings(item: SuiteCatalogPluginItem, prepared: PreparedPlugin): void {
  if (item.serviceSlots?.some(slot => !prepared.services?.includes(slot.binding.service)))
    throw new BusinessRuleError('invalid', 'The plugin did not register its declared settings service.', 'suite-catalog-invalid')
  const cache = item.resourceBindings?.find(binding => binding.kind === 'native-package-cache')
  if (!cache) return
  const packages = new Map(cache.packages.map(row => [row.packageName, row.version]))
  const optional = prepared.optionalDependencies ?? {},
    declared = { ...prepared.dependencies, ...optional }
  if (
    Object.keys(prepared.dependencies).some(name => !Object.hasOwn(optional, name) && !packages.has(name)) ||
    cache.packages.some(({ packageName, version }) => {
      const range = Object.hasOwn(declared, packageName) ? declared[packageName] : undefined
      return !range || !satisfiesSemverRange(version, range)
    })
  )
    throw new BusinessRuleError('invalid', 'The package cache pins do not match the plugin dependencies.', 'suite-catalog-invalid')
}

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
  policy: {
    readonly serviceIdentity?: InstalledServiceIdentity
    readonly compatibilityTarget?: string
    readonly takeover?: { readonly row: LibraryPlugin; readonly revision: string }
  } = {},
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
  assertCatalogPluginBindings(item, plan.prepared)
  readyRuntimeDependencies(await rows.runtime.list(), dependencies)
  const resourceNames = new Set(item.resourceBindings?.flatMap(binding => ('name' in binding ? [binding.name] : []))),
    resourceEnvironment = item.access.environment.filter(row => resourceNames.has(row.name)),
    priorResources = current?.suiteResourceEnvironment ?? [],
    priorNames = new Set(priorResources.map(row => row.name))
  const modified = mode === 'update' && current?.suiteAppliedAccess !== pluginAccessIdentity(settings ?? { environment: [], entriesYaml: '' }),
    previousAccess = settings ?? { environment: [], entriesYaml: '' },
    previousValues = new Map(previousAccess.environment.map(row => [row.name, row.value]))
  if (
    modified &&
    (priorResources.some(row => previousValues.get(row.name) !== row.value) ||
      resourceEnvironment.some(row => previousValues.has(row.name) && !priorNames.has(row.name)))
  )
    throw new BusinessRuleError('conflict', 'Plugin access settings conflict with the locked resource binding.', 'plugin-impact-changed')
  const template = modified
    ? { environment: [...previousAccess.environment.filter(row => !priorNames.has(row.name)), ...resourceEnvironment], entriesYaml: previousAccess.entriesYaml }
    : item.access
  const access = new PluginAccessAdministration(rows.accounts, rows.plugins, rows.pluginAccess, rows.pluginUpstreams, syntax),
    checked = await access.validateSuiteTemplate(plan.prepared, template, dependencies)
  const {
    upload,
    replacement,
    failureCode,
    incompatible,
    restorePublication,
    retainedIntegrity,
    suiteResourceEnvironment,
    suiteResourceBindings,
    ...metadata
  } = current ?? {}
  void upload
  void replacement
  void failureCode
  void incompatible
  void restorePublication
  void retainedIntegrity
  void suiteResourceEnvironment
  void suiteResourceBindings
  const declaredDependencies = [...plan.item.runtimeDependencies, ...plan.item.catalogDependencies]
  const resourceBindings = item.resourceBindings?.map(binding => ({
    ...binding,
    runtimeDependency: dependencies[declaredDependencies.indexOf(binding.dependency)]!,
  }))
  const row: LibraryPlugin = {
    ...metadata,
    packageName: item.packageName,
    version: item.version,
    source: item.archive ? uploadPluginSource : npmPluginSource,
    runtimeDependencies: [...dependencies],
    suiteOrigin: origin,
    ...(resourceBindings?.length ? { suiteResourceBindings: resourceBindings } : {}),
    ...(modified ? {} : { suiteAppliedAccess: pluginAccessIdentity(item.access) }),
    ...(resourceEnvironment.length ? { suiteResourceEnvironment: resourceEnvironment } : {}),
    current: item.archive ? { ...plan.prepared, catalogArchiveUrl: item.archive.url } : plan.prepared,
    stage: 'available',
    published: current?.published === true || current?.restorePublication === true,
    identities: { ...pluginIdentities(current), [item.version]: item.integrity },
    ...(compatibilityTarget ? { checkedFor: compatibilityTarget } : {}),
  }
  await rows.plugins.save(row, current?.revision ?? 'none')
  if (!modified || priorResources.length || resourceEnvironment.length)
    await rows.pluginAccess.save(item.packageName, checked, undefined, settings?.revision ?? 'none')
  if (item.serviceSlots && (!policy.serviceIdentity || !rows.pluginAccess.saveInstalledServices || !rows.pluginAccess.installedServices))
    throw new BusinessRuleError('invalid', 'Installed service configuration storage is unavailable.', 'suite-catalog-invalid')
  const previousServices = await rows.pluginAccess.installedServices?.(item.packageName)
  if (policy.serviceIdentity && (item.serviceSlots || previousServices)) {
    const configuration = installServiceDefinition(policy.serviceIdentity, item.serviceSlots, mode === 'update' ? previousServices?.configuration : undefined)
    await rows.pluginAccess.saveInstalledServices!(
      item.packageName,
      origin,
      configuration ? { ...configuration, ownerVersion: plan.prepared.integrity } : undefined,
      previousServices?.revision ?? 'none',
    )
  }
  return row
}
