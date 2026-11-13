import { executionShortOption } from './execution-command-line.js'
import { pythonPackagePins } from './python-library.js'
import {
  normalizeSuiteCatalogDocument,
  parseSuiteCatalogJson,
  suiteCatalogContentHash,
  suiteCatalogFormat,
  type SuiteCatalogDocumentDependencyEntry,
  type SuiteCatalogDocumentEntry,
  type SuiteCatalogDocumentSuiteEntry,
  type SuiteCatalogItem as SuiteCatalogDocumentItem,
  type SuiteCatalogLocalized,
} from './suite-catalog-document.js'
import { verifySuiteCatalogSignature, type TrustedSuiteCatalogKey } from './suite-catalog-signature.js'
import { validateSuiteCatalogAdapters, type ValidatedSuiteCatalogAdapter } from './suite-catalog-adapters.js'
import { suiteEntryViolations, suiteResourceBindingViolations } from './suite-catalog-checks.js'
import type { SuiteCatalogEntry, SuiteCatalogExecutionItem, SuiteCatalogItem } from './suite-catalog.js'
import type { SuiteCatalogRuntimeDependencyItem as SuiteCatalogDocumentRuntimeItem } from './suite-catalog-document.js'
import { suitePrepareCheckCommand, suitePrepareCommands } from './suite-prepare-commands.js'
import { compareSemver, parseSemver, parseSemverRange, satisfiesSemverRange } from './semver.js'
import { readCatalogPluginArchive } from './suite-plugin.js'
import { readCatalogResourceBindings } from './suite-resource-bindings.js'
import { resourceReadiness } from './suite-resource-readiness.js'
import { readExecutionServiceSlots, readPluginServiceSlots } from './suite-service-slots.js'

const itemExtensionFields = ['archive', 'requiredFiles', 'resourceBindings', 'serviceSlots', 'blockedShortOptions', 'shortOptionsWithValue'] as const
const misplacedExtension = 'Catalog extension is declared at the wrong level.'

/** Entries the reader refused; the gallery shows them unavailable with the reason. */
export type SuiteCatalogEntryRejection = 'needs-platform-upgrade' | 'unknown-adapter' | 'invalid-adapter-params' | 'content-hash-mismatch' | 'invalid-entry'
export interface RejectedSuiteCatalogEntry {
  readonly id: string
  readonly version: string
  readonly reason: SuiteCatalogEntryRejection
  readonly detail?: string
}
/** A valid entry whose kind this platform version does not render yet. */
export interface SkippedSuiteCatalogEntry {
  readonly id: string
  readonly kind: string
}
export interface ReadSuiteCatalogEntry {
  readonly entry: SuiteCatalogEntry
  readonly contentHash: string
  /** Set when the entry is signed but this platform must not install it; it still appears in the gallery. */
  readonly unavailableReason?: SuiteCatalogEntryRejection
  readonly unavailableDetail?: string
}
export type SuiteCatalogReadRejection = 'invalid-document' | 'unsupported-format' | 'unknown-key' | 'invalid-signature'
export type SuiteCatalogRead =
  | { readonly status: 'rejected'; readonly reason: SuiteCatalogReadRejection; readonly detail?: string }
  | {
      readonly status: 'ok'
      readonly publishedAt: string
      readonly entries: readonly ReadSuiteCatalogEntry[]
      readonly rejected: readonly RejectedSuiteCatalogEntry[]
      readonly skipped: readonly SkippedSuiteCatalogEntry[]
    }

export interface ReadSuiteCatalogOptions {
  readonly trustedKeys: readonly TrustedSuiteCatalogKey[]
  readonly platformVersion: string
}

/**
 * The whole trust boundary for the online catalog: parse the received JSON, verify the Ed25519 signature over its
 * canonical form (unknown members included), check each entry's content hash over the same received object, then
 * apply compatibility and download rules. Only after verification is the document normalized for behavior.
 */
export function readSuiteCatalog(bytes: Uint8Array, options: ReadSuiteCatalogOptions): SuiteCatalogRead {
  const parsed = parseSuiteCatalogJson(bytes)
  if (!parsed.okay) return { status: 'rejected', reason: 'invalid-document', ...(parsed.detail ? { detail: parsed.detail } : {}) }
  const raw = parsed.raw
  if (raw.format !== suiteCatalogFormat) return { status: 'rejected', reason: 'unsupported-format' }
  const signature = verifySuiteCatalogSignature(raw, options.trustedKeys)
  if (signature !== 'ok') return { status: 'rejected', reason: signature }
  return readCheckedSuiteCatalog(raw, options.platformVersion)
}

/** Publication boundary: checks unsigned data; never used by the online trust boundary. */
export function checkUnsignedSuiteCatalog(raw: Record<string, unknown>, platformVersion: string): SuiteCatalogRead {
  return readCheckedSuiteCatalog({ ...raw, signature: { keyId: 'unsigned-check', signature: 'unsigned-check' } }, platformVersion)
}

function readCheckedSuiteCatalog(raw: Record<string, unknown>, platformVersion: string): SuiteCatalogRead {
  if (['locked', ...itemExtensionFields].some(key => Object.hasOwn(raw, key)))
    return { status: 'rejected', reason: 'invalid-document', detail: misplacedExtension }
  const normalized = normalizeSuiteCatalogDocument(raw)
  if (!normalized.okay)
    return {
      status: 'rejected',
      reason: normalized.rejection === 'unsupported-format' ? 'unsupported-format' : 'invalid-document',
      ...(normalized.detail ? { detail: normalized.detail } : {}),
    }
  const rawEntries = raw.entries as readonly unknown[]
  const entries: ReadSuiteCatalogEntry[] = [],
    rejected: RejectedSuiteCatalogEntry[] = [],
    skipped: SkippedSuiteCatalogEntry[] = []
  normalized.document.entries.forEach((entry, index) => {
    // Reserved kinds are skipped before any compatibility rule; the signature and structure were already verified.
    if (entry.kind !== 'suite' && entry.kind !== 'dependency' && entry.kind !== 'plugin') {
      skipped.push({ id: entry.id, kind: entry.kind })
      return
    }
    const read = readGalleryEntry(entry, rawEntries[index], platformVersion)
    if (read.problem)
      rejected.push({ id: entry.id, version: entry.version, reason: read.problem.reason, ...(read.problem.detail ? { detail: read.problem.detail } : {}) })
    entries.push({
      entry: {
        ...read.entry,
        ...(read.problem ? { unavailableReason: read.problem.reason } : {}),
        ...(read.problem?.detail ? { unavailableDetail: read.problem.detail } : {}),
      },
      contentHash: entry.contentHash,
      ...(read.problem ? { unavailableReason: read.problem.reason } : {}),
      ...(read.problem?.detail ? { unavailableDetail: read.problem.detail } : {}),
    })
  })
  const available = entries.filter(row => !row.unavailableReason).map(row => row.entry)
  const checked = entries.map(row => {
    if (row.unavailableReason) return row
    const [detail] = suiteResourceBindingViolations(row.entry, available)
    if (!detail) return row
    const unavailable = { unavailableReason: 'invalid-entry', unavailableDetail: detail } as const
    rejected.push({ id: row.entry.id, version: row.entry.version, reason: unavailable.unavailableReason, detail })
    return { ...row, ...unavailable, entry: { ...row.entry, ...unavailable } }
  })
  return { status: 'ok', publishedAt: normalized.document.publishedAt, entries: checked, rejected, skipped }
}

/**
 * The entry declarations adapter validation must see. Exported so tests build their fixture context from this same
 * source instead of re-deriving service addresses, dependencies and execution variables on their own.
 */
export function suiteAdapterValidationContext(entry: SuiteCatalogDocumentDependencyEntry | SuiteCatalogDocumentSuiteEntry): {
  readonly serviceAddresses: readonly string[]
  readonly dependencies: readonly string[]
  readonly executionVariables: readonly string[]
} {
  return {
    serviceAddresses: entry.kind !== 'dependency' ? (entry.serviceAddresses ?? []) : [],
    dependencies: entry.kind !== 'dependency' ? entry.dependencies : [],
    // Token bodies may only name this suite's delegated-execution variables.
    executionVariables:
      entry.kind !== 'dependency' ? entry.items.flatMap(item => (item.kind === 'execution' ? item.variables.map(variable => variable.name) : [])) : [],
  }
}

interface GalleryEntryRead {
  readonly entry: SuiteCatalogEntry
  readonly problem?: { readonly reason: SuiteCatalogEntryRejection; readonly detail?: string }
}

function readGalleryEntry(
  entry: SuiteCatalogDocumentDependencyEntry | SuiteCatalogDocumentSuiteEntry,
  rawEntry: unknown,
  platformVersion: string,
): GalleryEntryRead {
  if (typeof rawEntry !== 'object' || rawEntry === null || suiteCatalogContentHash(rawEntry) !== entry.contentHash)
    return { entry: convertEntry(entry, []), problem: { reason: 'content-hash-mismatch' } }
  // Platform compatibility comes first: an older platform must report that it needs an upgrade, not misreport a
  // newer adapter it does not know as an unknown one.
  if (!satisfiesSemverRange(platformVersion, entry.engines.platform))
    return { entry: convertEntry(entry, []), problem: { reason: 'needs-platform-upgrade', detail: entry.engines.platform } }
  const runtimeItems = entry.items.filter((item): item is SuiteCatalogDocumentRuntimeItem => item.kind === 'runtime-dependency')
  const adapterCheck = validateSuiteCatalogAdapters(entry.adapters, runtimeItems, suiteAdapterValidationContext(entry))
  if (!adapterCheck.okay) return { entry: convertEntry(entry, []), problem: { reason: adapterCheck.code, detail: adapterCheck.detail } }
  const converted = convertEntry(entry, adapterCheck.adapters)
  const raw = rawEntry as { readonly locked?: unknown; readonly items: readonly Record<string, unknown>[] }
  if (itemExtensionFields.some(key => Object.hasOwn(raw, key)) || raw.items.some(item => Object.hasOwn(item, 'locked')))
    return { entry: converted, problem: { reason: 'invalid-entry', detail: misplacedExtension } }
  if (Object.hasOwn(raw, 'locked') && (raw.locked !== true || converted.category !== 'dependency' || !requiresCatalogExtensionPlatform(entry.engines.platform)))
    return { entry: converted, problem: { reason: 'invalid-entry', detail: 'Only dependencies can be locked on platform >=0.1.35.' } }
  const rawItems = raw.items
  const items = [...converted.items]
  for (const [index, item] of items.entries()) {
    const raw = rawItems[index]!
    if (hasShortOptionDeclaration(raw) || (item.kind !== 'execution' && Array.isArray(raw.delegated) && raw.delegated.some(hasShortOptionDeclaration)))
      return { entry: converted, problem: { reason: 'invalid-entry', detail: misplacedExtension } }
    if (Object.hasOwn(raw, 'archive')) {
      if (item.kind !== 'plugin') return { entry: converted, problem: { reason: 'invalid-entry', detail: 'An archive can only be declared on a plugin.' } }
      const archive = readCatalogPluginArchive(raw.archive)
      if (!archive || !requiresCatalogExtensionPlatform(entry.engines.platform))
        return {
          entry: converted,
          problem: { reason: 'invalid-entry', detail: 'Plugin archives require a GitHub Release asset and engines.platform >=0.1.35.' },
        }
      items[index] = { ...item, archive }
    }
    if (Object.hasOwn(raw, 'requiredFiles')) {
      const readiness = item.kind === 'runtime-dependency' && resourceReadiness(item, raw.requiredFiles)
      if (item.kind !== 'runtime-dependency' || !readiness || !requiresCatalogExtensionPlatform(entry.engines.platform))
        return { entry: converted, problem: { reason: 'invalid-entry', detail: 'Required files need a checksummed resource and engines.platform >=0.1.35.' } }
      items[index] = { ...item, ...readiness }
    }
    if (Object.hasOwn(raw, 'resourceBindings')) {
      const plugin = items[index]!
      const resourceBindings = plugin.kind === 'plugin' && readCatalogResourceBindings(plugin, raw.resourceBindings)
      if (plugin.kind !== 'plugin' || !resourceBindings || !requiresCatalogExtensionPlatform(entry.engines.platform))
        return { entry: converted, problem: { reason: 'invalid-entry', detail: 'Resource bindings require pinned plugin dependencies and platform >=0.1.35.' } }
      const environment = resourceBindings.flatMap(binding =>
        'name' in binding ? [{ name: binding.name, value: '{dependency:' + binding.dependency + '}' + (binding.path === '.' ? '' : '/' + binding.path) }] : [],
      )
      items[index] = { ...plugin, resourceBindings, access: { ...plugin.access, environment: [...plugin.access.environment, ...environment] } }
    }
    if (item.kind === 'execution') {
      const declarations = raw.delegated as readonly Record<string, unknown>[]
      if (declarations.some(hasShortOptionDeclaration)) {
        const delegated = withProtectedShortOptions(item, declarations)
        if (!delegated || !requiresCatalogExtensionPlatform(entry.engines.platform))
          return { entry: converted, problem: { reason: 'invalid-entry', detail: 'Protected short options require valid flags and platform >=0.1.35.' } }
        items[index] = { ...item, delegated }
      }
    }
    if (Object.hasOwn(raw, 'serviceSlots')) {
      const updated = itemWithServiceSlots(items[index]!, raw.serviceSlots)
      if (!updated || !requiresCatalogExtensionPlatform(entry.engines.platform))
        return { entry: converted, problem: { reason: 'invalid-entry', detail: 'Service slots require valid fields and engines.platform >=0.1.35.' } }
      items[index] = updated
    }
  }
  if (converted.category === 'dependency' && raw.locked === true) {
    const dependency = entry.items[0]
    if (
      items.length !== 1 ||
      dependency?.kind !== 'runtime-dependency' ||
      dependency.check !== undefined ||
      dependency.downloads.some(download => download.source !== 'github-assets' && download.source !== 'browser')
    )
      return {
        entry: converted,
        problem: { reason: 'invalid-entry', detail: 'A locked dependency supplies one checksummed runtime artifact and uses platform readiness checks.' },
      }
    return checkEntryViolations({ ...converted, items, locked: true })
  }
  return checkEntryViolations({ ...converted, items })
}

function hasShortOptionDeclaration(value: unknown): boolean {
  return typeof value === 'object' && value !== null && ['blockedShortOptions', 'shortOptionsWithValue'].some(key => Object.hasOwn(value, key))
}

function withProtectedShortOptions(item: SuiteCatalogExecutionItem, declarations: readonly Record<string, unknown>[]) {
  const delegated = []
  for (const [index, command] of item.delegated.entries()) {
    const raw = declarations[index]
    if (!hasShortOptionDeclaration(raw)) {
      delegated.push(command)
      continue
    }
    const { blockedShortOptions, shortOptionsWithValue } = raw!
    if (
      !Array.isArray(blockedShortOptions) ||
      !blockedShortOptions.length ||
      !blockedShortOptions.every(executionShortOption) ||
      blockedShortOptions.length + (command.blockedOptions?.length ?? 0) > 100
    )
      return
    if (
      shortOptionsWithValue !== undefined &&
      (!Array.isArray(shortOptionsWithValue) ||
        !shortOptionsWithValue.length ||
        shortOptionsWithValue.length > 100 ||
        !shortOptionsWithValue.every(executionShortOption) ||
        shortOptionsWithValue.some(option => blockedShortOptions.includes(option)))
    )
      return
    delegated.push({
      ...command,
      blockedOptions: [...new Set([...(command.blockedOptions ?? []), ...blockedShortOptions])],
      ...(shortOptionsWithValue ? { shortOptionsWithValue: [...new Set(shortOptionsWithValue)] } : {}),
    })
  }
  return delegated
}

function itemWithServiceSlots(item: SuiteCatalogItem, raw: unknown): SuiteCatalogItem | undefined {
  if (item.kind === 'plugin') {
    const serviceSlots = readPluginServiceSlots(raw)
    return serviceSlots ? { ...item, serviceSlots } : undefined
  }
  if (item.kind === 'execution') {
    const serviceSlots = readExecutionServiceSlots(item, raw)
    return serviceSlots ? { ...item, serviceSlots } : undefined
  }
}

function requiresCatalogExtensionPlatform(platform: string): boolean {
  const floor = parseSemver('0.1.35')!
  return parseSemverRange(platform)!.every(branch =>
    branch.some(bound => (bound.operator === '>' || bound.operator === '>=' || bound.operator === '=') && compareSemver(bound.version, floor) >= 0),
  )
}

function checkEntryViolations(converted: SuiteCatalogEntry): GalleryEntryRead {
  // The catalog rules run at runtime too, so a signed entry cannot bypass download-source prefixes, checksums or pins.
  const violations = suiteEntryViolations(converted)
  if (violations.length) return { entry: converted, problem: { reason: 'invalid-entry', detail: violations.join('; ') } }
  return { entry: converted }
}

function localized(value: SuiteCatalogLocalized): Readonly<Record<'en' | 'zh-CN', string>> {
  return { en: value.en, 'zh-CN': value['zh-CN'] }
}

function convertItem(item: SuiteCatalogDocumentItem, adapters: readonly ValidatedSuiteCatalogAdapter[]): SuiteCatalogItem {
  if (item.kind === 'runtime-dependency') {
    const check = suitePrepareCheckCommand(item)
    return {
      kind: 'runtime-dependency',
      name: item.name,
      ...(item.type === 'python-library'
        ? { type: item.type, packages: pythonPackagePins(item.downloads.flatMap(download => download.packages ?? []))! }
        : item.type === 'resource'
          ? { type: item.type }
          : {}),
      prepareCommands: suitePrepareCommands(item, adapters),
      pathDirectories: [...item.paths],
      commands: [...item.commands],
      ...(check ? { checkCommand: check } : {}),
    }
  }
  if (item.kind === 'plugin') return item
  if (item.kind === 'skill')
    return {
      kind: 'skill',
      source: { ...item.source },
      names: [...item.names],
      ...(item.runtimeDependency ? { runtimeDependency: item.runtimeDependency } : {}),
      ...(item.catalogDependencies ? { catalogDependencies: [...item.catalogDependencies] } : {}),
    }
  if (item.kind === 'skill-pack') return { kind: 'skill-pack', name: item.name, description: item.description, note: item.note, skills: [...item.skills] }
  return {
    kind: 'execution',
    skill: item.skill,
    runtimeDependency: item.runtimeDependency,
    delegated: item.delegated.map(row => ({ ...row, blocked: [...row.blocked] })),
    variables: item.variables.map(row => ({ ...row, purpose: localized(row.purpose) })),
  }
}

function convertEntry(
  entry: Extract<SuiteCatalogDocumentEntry, { kind: 'suite' | 'plugin' | 'dependency' }>,
  adapters: readonly ValidatedSuiteCatalogAdapter[],
): SuiteCatalogEntry {
  const common = {
    id: entry.id,
    version: entry.version,
    contentHash: entry.contentHash,
    title: localized(entry.title),
    description: localized(entry.description),
    source: localized(entry.source),
    items: entry.items.map(item => convertItem(item, adapters)),
  }
  return entry.kind !== 'dependency'
    ? {
        category: entry.kind,
        ...common,
        identity: localized(entry.identity),
        dependencies: [...entry.dependencies],
        ...(entry.serviceAddresses?.length ? { serviceAddresses: [...entry.serviceAddresses] } : {}),
      }
    : { category: 'dependency', ...common }
}
