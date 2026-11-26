import { join } from 'node:path'
import {
  configureServiceBackend,
  installServiceDefinition,
  serviceBackendComplete,
  type InstalledServiceIdentity,
  type InstalledServiceSettings,
  type InstalledServices,
} from '../domain/installed-services.js'
import { installedCatalogIdentity } from '../domain/execution-service-environment.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { pluginAccessIdentity } from '../domain/plugin-access.js'
import { managedImageUpstreamHeaders, managedImageUpstreamTest, mergeUpstreamInput, type PluginUpstream } from '../domain/plugin-upstream.js'
import {
  assertPreparedPlugin,
  catalogPluginPredecessor,
  pluginCatalogRevision,
  pluginIdentities,
  PluginPreparationError,
  type LibraryPlugin,
  type PreparedPlugin,
  npmPluginSource,
  uploadPluginSource,
} from '../domain/plugin-library.js'
import type { RuntimeDependency } from '../domain/runtime-dependency.js'
import { PLAYWRIGHT_BROWSERS_ENV, sameCatalogResourceLocation, type CatalogResourceBinding } from '../domain/suite-resource-bindings.js'
import { invalidRequest, type SuiteCatalogEntry, type SuiteCatalogPluginItem, type SuiteInstallRequest } from '../domain/suite-catalog.js'
import { canonicalJson } from '../domain/suite-catalog-document.js'
import { deferredPluginUpstreams, type CatalogPluginServiceSlot } from '../domain/suite-service-slots.js'
import { satisfiesSemverRange } from '../domain/semver.js'
import { readyRuntimeDependencies } from '../domain/runtime-dependency-selection.js'
import type { PreparedBrowserDirectories, RuntimeDependencyReferencesPort } from '../ports/runtime-dependencies.js'
import type { PluginAccessSyntaxPort } from '../ports/plugin-access.js'
import type { SuiteRepositories } from '../ports/suite-unit-of-work.js'
import { PluginAccessAdministration } from './plugin-access-administration.js'
import { resolvedPluginItem } from './suite-entry-kinds.js'

type InstallAccessSettings = Pick<SuiteInstallRequest, 'imageSettings' | 'serviceSettings'>

function configureInstallServices(state: InstalledServices<CatalogPluginServiceSlot> | undefined, services: InstallAccessSettings['serviceSettings']) {
  let configured = state
  for (const { slot, backend, values } of services ?? []) {
    const definition = configured?.slots.find(row => row.id === slot)?.backends.find(row => row.id === backend)
    if (!configured || !definition || !serviceBackendComplete(definition, values)) throw invalidRequest()
    configured = configureServiceBackend(configured, { slot, backend, values, action: 'save' })
  }
  return configured
}

export function installPluginItem(entry: SuiteCatalogEntry, access: InstallAccessSettings) {
  const plugin = entry.category === 'plugin' ? entry.items.find(item => item.kind === 'plugin') : undefined
  const names = new Set(deferredPluginUpstreams(plugin?.serviceSlots))
  if (access.imageSettings?.some(row => !names.has(row.name))) throw invalidRequest()
  if (access.serviceSettings?.length)
    configureInstallServices(installServiceDefinition(installedCatalogIdentity(entry), plugin?.serviceSlots), access.serviceSettings)
  return plugin
}

export function assertCatalogPluginBindings(item: SuiteCatalogPluginItem, prepared: PreparedPlugin): void {
  if (canonicalJson(item.installDefaults ?? null) !== canonicalJson(prepared.installDefaults ?? null))
    throw new BusinessRuleError('invalid', 'The plugin install defaults were not verified by the plugin precheck.', 'suite-catalog-invalid')
  if (item.serviceSlots?.some(slot => slot.binding.kind === 'revisioned-rpc' && !prepared.services?.includes(slot.binding.service)))
    throw new BusinessRuleError('invalid', 'The plugin did not register its declared settings service.', 'suite-catalog-invalid')
  const cache = item.resourceBindings?.find(binding => binding.kind === 'native-package-cache')
  const packages = new Map(cache?.packages.map(row => [row.packageName, row.version]))
  const optional = prepared.optionalDependencies ?? {},
    declared = { ...prepared.dependencies, ...optional }
  const browser = item.resourceBindings?.find(binding => binding.kind === 'playwright-browser')
  if (browser) {
    const playwright = Object.entries(declared).filter(([name]) => name === 'playwright' || name === 'playwright-core')
    if (
      !playwright.length ||
      playwright.some(([name, range]) => (packages.get(name) ?? range) !== browser.playwrightVersion || !satisfiesSemverRange(browser.playwrightVersion, range))
    )
      throw new BusinessRuleError('invalid', 'The browser binding must match an exact Playwright package pin.', 'suite-catalog-invalid')
  }
  if (!cache) return
  if (
    Object.keys(prepared.dependencies).some(name => !Object.hasOwn(optional, name) && !packages.has(name)) ||
    cache.packages.some(({ packageName, version }) => {
      const range = Object.hasOwn(declared, packageName) ? declared[packageName] : undefined
      return !range || !satisfiesSemverRange(version, range)
    })
  )
    throw new BusinessRuleError('invalid', 'The package cache pins do not match the plugin dependencies.', 'suite-catalog-invalid')
}

/** Compare prepared directories and installed pins under the catalog transaction's locks. */
async function assertPreparedSuitePlaywrightBrowser(
  item: SuiteCatalogPluginItem,
  dependencies: readonly string[],
  runtime: readonly RuntimeDependency[],
  plugins: readonly LibraryPlugin[],
  memberReferences: Pick<RuntimeDependencyReferencesPort, 'retainedBrowserBindings'>,
  directories?: PreparedBrowserDirectories,
): Promise<void> {
  const isBrowser = (binding: CatalogResourceBinding) =>
    binding.kind === 'playwright-browser' || ('name' in binding && binding.name === PLAYWRIGHT_BROWSERS_ENV)
  const declarations = item.resourceBindings?.filter(isBrowser) ?? []
  if (!declarations.length) return

  const read = async (name: string, path: string): Promise<readonly string[]> => {
    const version = runtime.find(row => row.name === name)?.current
    return version && directories ? directories(join(version.directory, path)) : []
  }
  const declared = [...item.runtimeDependencies, ...item.catalogDependencies]
  const references = [
    ...plugins.flatMap(plugin => (plugin.suiteResourceBindings ?? []).filter(isBrowser)),
    ...((await memberReferences.retainedBrowserBindings?.()) ?? []),
  ]
  const buildDirectory = (name: string) => name.replace(/_headless_shell(?=-)/u, '')
  for (const binding of declarations) {
    const candidate = { ...binding, runtimeDependency: dependencies[declared.indexOf(binding.dependency)]! }
    const available = await read(candidate.runtimeDependency, candidate.path)
    if (candidate.kind === 'playwright-browser' && !candidate.directories.every(directory => available.includes(directory)))
      throw new BusinessRuleError('invalid', 'Prepared Playwright browser build is unavailable.', 'suite-catalog-invalid')

    for (const reference of references) {
      if (sameCatalogResourceLocation(reference, candidate)) continue
      const typed = candidate.kind === 'playwright-browser' ? candidate : reference.kind === 'playwright-browser' ? reference : undefined
      if (!typed) continue
      const peer = typed === candidate ? reference : candidate
      const matches =
        peer.kind === 'playwright-browser'
          ? peer.chromiumBuild === typed.chromiumBuild
          : (peer === candidate ? available : await read(peer.runtimeDependency, peer.path)).some(directory =>
              typed.directories.some(declared => buildDirectory(directory) === buildDirectory(declared)),
            )
      if (matches) throw new BusinessRuleError('conflict', 'Playwright browser build already has a locked resource.', 'suite-catalog-invalid')
    }
    references.push(candidate)
  }
}

export interface SuitePluginWiring {
  readonly syntax?: PluginAccessSyntaxPort
  readonly compatibilityTarget?: string
  readonly browserDirectories?: PreparedBrowserDirectories
}

export interface PreparedSuitePlugin {
  readonly item: SuiteCatalogPluginItem
  readonly prepared: PreparedPlugin
  readonly accessRevision: string
}

function legacyImageSettings(slots: readonly CatalogPluginServiceSlot[] | undefined, previous: InstalledServices<CatalogPluginServiceSlot> | undefined) {
  const migrations = new Map<string, { model: string | undefined; setting: InstalledServiceSettings | undefined }>()
  for (const slot of slots ?? []) {
    const { binding } = slot
    if (binding.kind !== 'json-settings' || !binding.deferredUpstream) continue
    const prior = previous?.slots.find(row => row.id === slot.id)
    if (
      prior?.binding.kind !== 'json-settings' ||
      prior.binding.deferredUpstream ||
      canonicalJson({ ...prior.binding, deferredUpstream: true }) !== canonicalJson(binding) ||
      prior.backends.length !== 1
    )
      continue
    const backend = prior.backends[0]!
    const target = slot.backends[0]
    if (
      target?.id !== backend.id ||
      target.mode !== backend.mode ||
      target.protocol !== 'openai-image' ||
      backend.protocol !== 'openai-image' ||
      backend.fields.some(field => field.name !== backend.upstream.model)
    )
      continue
    if (migrations.has(binding.upstream))
      throw new BusinessRuleError('conflict', 'Multiple legacy image services use the same upstream.', 'platform-configuration-conflict')
    const setting = previous?.settings.find(row => row.slot === slot.id && row.backend === backend.id)
    migrations.set(binding.upstream, { model: setting?.values[backend.upstream.model], setting })
  }
  return migrations
}

/** Parent and settings are read after the catalog acquired their locks; no checkpoint or external preparation is written here. */
export async function writeSuitePlugin(
  rows: Pick<SuiteRepositories, 'accounts' | 'plugins' | 'pluginAccess' | 'pluginUpstreams' | 'runtime' | 'runtimeReferences'>,
  origin: string,
  plan: PreparedSuitePlugin,
  dependencies: readonly string[],
  mode: 'install' | 'update',
  policy: SuitePluginWiring & {
    readonly catalogDisplay?: Pick<import('../domain/suite-catalog.js').SuiteCatalogSuiteEntry, 'title' | 'description'>
    readonly serviceIdentity?: InstalledServiceIdentity
    readonly takeover?: { readonly row: LibraryPlugin; readonly revision: string }
    readonly accessSettings?: InstallAccessSettings
  } = {},
): Promise<LibraryPlugin> {
  const { compatibilityTarget, takeover, syntax } = policy
  if (!syntax) throw new BusinessRuleError('invalid', 'Plugin preparation is unavailable.', 'suite-catalog-invalid')
  const item = resolvedPluginItem(plan.item, dependencies),
    plugins = await rows.plugins.list(),
    current = plugins.find(row => row.packageName === item.packageName),
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
  const runtime = await rows.runtime.list()
  readyRuntimeDependencies(runtime, dependencies)
  await assertPreparedSuitePlaywrightBrowser(plan.item, dependencies, runtime, plugins, rows.runtimeReferences, policy.browserDirectories)
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
  const declaredUpstreams = new Set(deferredPluginUpstreams(item.serviceSlots))
  const { imageSettings, serviceSettings } = policy.accessSettings ?? {}
  if (imageSettings?.some(input => !declaredUpstreams.has(input.name))) throw invalidRequest()
  const access = new PluginAccessAdministration(rows.accounts, rows.plugins, rows.pluginAccess, rows.pluginUpstreams, syntax),
    checked = await access.validateSuiteTemplate(plan.prepared, template, dependencies, [...declaredUpstreams])
  const {
    upload,
    replacement,
    failureCode,
    incompatible,
    restorePublication,
    retainedIntegrity,
    suiteResourceEnvironment,
    suiteResourceBindings,
    catalogReplacement: _catalogReplacement,
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
  void _catalogReplacement
  const declaredDependencies = [...plan.item.runtimeDependencies, ...plan.item.catalogDependencies]
  const resourceBindings = item.resourceBindings?.map(binding => ({
    ...binding,
    runtimeDependency: dependencies[declaredDependencies.indexOf(binding.dependency)]!,
  }))
  const from = item.replaces,
    prior = current?.current,
    retained = current && prior && catalogPluginPredecessor(current, prior)
  const replacing =
    mode === 'update' &&
    current?.suiteOrigin === origin &&
    from &&
    ((prior?.version === from.version && prior.integrity === from.integrity) ||
      (retained && retained.version === from.version && retained.integrity === from.integrity))
  if (replacing && canonicalJson(suiteResourceBindings ?? []) !== canonicalJson(resourceBindings ?? []))
    throw new BusinessRuleError('conflict', 'Keep the locked resource bindings while replacing a catalog plugin archive.', 'plugin-impact-changed')
  const row: LibraryPlugin = {
    ...metadata,
    ...(policy.catalogDisplay
      ? { display: { ...current?.display, catalogDefaults: { title: policy.catalogDisplay.title, description: policy.catalogDisplay.description } } }
      : {}),
    packageName: item.packageName,
    version: item.version,
    source: item.archive ? uploadPluginSource : npmPluginSource,
    runtimeDependencies: [...dependencies],
    suiteOrigin: origin,
    ...(replacing ? { catalogReplacement: { from, to: { version: item.version, integrity: item.integrity } } } : {}),
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
  const previousServices = await rows.pluginAccess.installedServices?.(item.packageName)
  const previous = mode === 'update' ? previousServices?.configuration : undefined
  const migrations = legacyImageSettings(item.serviceSlots, previous?.ownerVersion === current?.current?.integrity ? previous : undefined)
  const protectedUpstreams = new Set([...declaredUpstreams, ...deferredPluginUpstreams(previousServices?.configuration.slots)])
  if (protectedUpstreams.size) {
    const revision = await rows.pluginUpstreams.revision?.(item.packageName)
    const upstreams = await rows.pluginUpstreams.list(item.packageName)
    // Reserve the name even before configuration, so an older ordinary save cannot claim it.
    const pending: PluginUpstream[] = [...declaredUpstreams]
      .filter(name => !upstreams.some(upstream => upstream.name === name))
      .map(name => ({
        name,
        baseUrl: '',
        credential: '',
        nativeServiceOnly: true,
        headers: managedImageUpstreamHeaders,
        testRequest: managedImageUpstreamTest,
      }))
    if (
      migrations.size ||
      imageSettings?.length ||
      pending.length ||
      upstreams.some(upstream => protectedUpstreams.has(upstream.name) && !upstream.nativeServiceOnly)
    ) {
      const chosen = new Map(imageSettings?.map(input => [input.name, input]))
      await rows.pluginUpstreams.save(
        item.packageName,
        [...upstreams, ...pending].map(upstream => {
          if (!protectedUpstreams.has(upstream.name)) return upstream
          const migrated = migrations.get(upstream.name)
          if (migrated) {
            const { model: previousModel, ...connection } = upstream
            void previousModel
            return {
              ...connection,
              ...(migrated.model ? { model: migrated.model } : {}),
              ...(migrated.setting?.enabled === false ? { imageDisabled: true } : {}),
              nativeServiceOnly: true,
            }
          }
          const input = chosen.get(upstream.name)
          const settings = input
            ? mergeUpstreamInput({ ...input, headers: upstream.headers, testRequest: upstream.testRequest ?? managedImageUpstreamTest }, upstream)
            : upstream
          return { ...settings, nativeServiceOnly: true }
        }),
        undefined,
        revision,
      )
    }
  }
  if (!modified || priorResources.length || resourceEnvironment.length)
    await rows.pluginAccess.save(item.packageName, checked, undefined, settings?.revision ?? 'none')
  if (item.serviceSlots && (!policy.serviceIdentity || !rows.pluginAccess.saveInstalledServices || !rows.pluginAccess.installedServices))
    throw new BusinessRuleError('invalid', 'Installed service configuration storage is unavailable.', 'suite-catalog-invalid')
  if (policy.serviceIdentity && (item.serviceSlots || previousServices)) {
    const moved = new Set([...migrations.values()].map(row => row.setting))
    const retained = previous && migrations.size ? { ...previous, settings: previous.settings.filter(setting => !moved.has(setting)) } : previous
    const definition = installServiceDefinition(policy.serviceIdentity, item.serviceSlots, retained)
    const configuration = configureInstallServices(definition, serviceSettings)
    await rows.pluginAccess.saveInstalledServices!(
      item.packageName,
      origin,
      configuration ? { ...configuration, ownerVersion: plan.prepared.integrity } : undefined,
      previousServices?.revision ?? 'none',
    )
  }
  return row
}
