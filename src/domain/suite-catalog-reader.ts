import { normalizeSuiteCatalogDocument, parseSuiteCatalogJson, suiteCatalogContentHash, suiteCatalogFormat, type SuiteCatalogDocumentDependencyEntry, type SuiteCatalogDocumentEntry, type SuiteCatalogDocumentSuiteEntry, type SuiteCatalogItem as SuiteCatalogDocumentItem, type SuiteCatalogLocalized } from './suite-catalog-document.js'
import { verifySuiteCatalogSignature, type TrustedSuiteCatalogKey } from './suite-catalog-signature.js'
import { validateSuiteCatalogAdapters, type ValidatedSuiteCatalogAdapter } from './suite-catalog-adapters.js'
import { suiteEntryViolations } from './suite-catalog-checks.js'
import type { SuiteCatalogEntry, SuiteCatalogItem } from './suite-catalog.js'
import type { SuiteCatalogRuntimeDependencyItem as SuiteCatalogDocumentRuntimeItem } from './suite-catalog-document.js'
import { suitePrepareCheckCommand, suitePrepareCommands } from './suite-prepare-commands.js'
import { satisfiesSemverRange } from './semver.js'

/** Entries the reader refused; the gallery shows them unavailable with the reason. */
export type SuiteCatalogEntryRejection = 'needs-platform-upgrade' | 'unknown-adapter' | 'invalid-adapter-params' | 'content-hash-mismatch' | 'invalid-entry'
export interface RejectedSuiteCatalogEntry {
  readonly id: string
  readonly version: string
  readonly reason: SuiteCatalogEntryRejection
  readonly detail?: string
}
/** A valid entry whose kind this platform version does not render yet. */
export interface SkippedSuiteCatalogEntry { readonly id: string, readonly kind: string }
export interface ReadSuiteCatalogEntry {
  readonly entry: SuiteCatalogEntry
  readonly contentHash: string
  /** Set when the entry is signed but this platform must not install it; it still appears in the gallery. */
  readonly unavailableReason?: SuiteCatalogEntryRejection
  readonly unavailableDetail?: string
}
export type SuiteCatalogReadRejection = 'invalid-document' | 'unsupported-format' | 'unknown-key' | 'invalid-signature'
export type SuiteCatalogRead =
  | { readonly status: 'rejected', readonly reason: SuiteCatalogReadRejection, readonly detail?: string }
  | { readonly status: 'ok', readonly publishedAt: string, readonly entries: readonly ReadSuiteCatalogEntry[],
      readonly rejected: readonly RejectedSuiteCatalogEntry[], readonly skipped: readonly SkippedSuiteCatalogEntry[] }

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
  const normalized = normalizeSuiteCatalogDocument(raw)
  if (!normalized.okay) return { status: 'rejected', reason: normalized.rejection === 'unsupported-format' ? 'unsupported-format' : 'invalid-document', ...(normalized.detail ? { detail: normalized.detail } : {}) }
  const rawEntries = raw.entries as readonly unknown[]
  const entries: ReadSuiteCatalogEntry[] = [], rejected: RejectedSuiteCatalogEntry[] = [], skipped: SkippedSuiteCatalogEntry[] = []
  normalized.document.entries.forEach((entry, index) => {
    // Reserved kinds are skipped before any compatibility rule; the signature and structure were already verified.
    if (entry.kind !== 'suite' && entry.kind !== 'dependency') { skipped.push({ id: entry.id, kind: entry.kind }); return }
    const read = readGalleryEntry(entry, rawEntries[index], options.platformVersion)
    if (read.problem) rejected.push({ id: entry.id, version: entry.version, reason: read.problem.reason, ...(read.problem.detail ? { detail: read.problem.detail } : {}) })
    entries.push({ entry: { ...read.entry, ...(read.problem ? { unavailableReason: read.problem.reason } : {}), ...(read.problem?.detail ? { unavailableDetail: read.problem.detail } : {}) },
      contentHash: entry.contentHash, ...(read.problem ? { unavailableReason: read.problem.reason } : {}), ...(read.problem?.detail ? { unavailableDetail: read.problem.detail } : {}) })
  })
  return { status: 'ok', publishedAt: normalized.document.publishedAt, entries, rejected, skipped }
}

interface GalleryEntryRead {
  readonly entry: SuiteCatalogEntry
  readonly problem?: { readonly reason: SuiteCatalogEntryRejection, readonly detail?: string }
}

function readGalleryEntry(entry: SuiteCatalogDocumentDependencyEntry | SuiteCatalogDocumentSuiteEntry, rawEntry: unknown, platformVersion: string): GalleryEntryRead {
  if (typeof rawEntry !== 'object' || rawEntry === null || suiteCatalogContentHash(rawEntry) !== entry.contentHash) return { entry: convertEntry(entry, []), problem: { reason: 'content-hash-mismatch' } }
  const runtimeItems = entry.items.filter((item): item is SuiteCatalogDocumentRuntimeItem => item.kind === 'runtime-dependency')
  const adapterCheck = validateSuiteCatalogAdapters(entry.adapters, runtimeItems)
  if (!adapterCheck.okay) return { entry: convertEntry(entry, []), problem: { reason: adapterCheck.code, detail: adapterCheck.detail } }
  const converted = convertEntry(entry, adapterCheck.adapters)
  if (!satisfiesSemverRange(platformVersion, entry.engines.platform)) return { entry: converted, problem: { reason: 'needs-platform-upgrade', detail: entry.engines.platform } }
  // The catalog rules run at runtime too, so a signed entry cannot bypass download-source prefixes, checksums or pins.
  const violations = suiteEntryViolations(converted)
  if (violations.length) return { entry: converted, problem: { reason: 'invalid-entry', detail: violations.join('; ') } }
  return { entry: converted }
}

function localized(value: SuiteCatalogLocalized): Readonly<Record<'en' | 'zh-CN', string>> { return { en: value.en, 'zh-CN': value['zh-CN'] } }

function convertItem(item: SuiteCatalogDocumentItem, adapters: readonly ValidatedSuiteCatalogAdapter[]): SuiteCatalogItem {
  if (item.kind === 'runtime-dependency') {
    const check = suitePrepareCheckCommand(item)
    return { kind: 'runtime-dependency', name: item.name, prepareCommands: suitePrepareCommands(item, adapters), pathDirectories: [...item.paths], commands: [...item.commands],
      ...(check ? { checkCommand: check } : {}) }
  }
  if (item.kind === 'skill') return { kind: 'skill', source: { ...item.source }, names: [...item.names],
    ...(item.runtimeDependency ? { runtimeDependency: item.runtimeDependency } : {}), ...(item.catalogDependencies ? { catalogDependencies: [...item.catalogDependencies] } : {}) }
  if (item.kind === 'skill-pack') return { kind: 'skill-pack', name: item.name, description: item.description, note: item.note, skills: [...item.skills] }
  return { kind: 'execution', skill: item.skill, runtimeDependency: item.runtimeDependency,
    delegated: item.delegated.map(row => ({ command: row.command, blocked: [...row.blocked] })),
    variables: item.variables.map(row => ({ name: row.name, purpose: localized(row.purpose) })) }
}

function convertEntry(entry: Extract<SuiteCatalogDocumentEntry, { kind: 'suite' | 'dependency' }>, adapters: readonly ValidatedSuiteCatalogAdapter[]): SuiteCatalogEntry {
  const common = { id: entry.id, version: entry.version, contentHash: entry.contentHash, title: localized(entry.title), description: localized(entry.description), source: localized(entry.source),
    items: entry.items.map(item => convertItem(item, adapters)) }
  return entry.kind === 'suite'
    ? { category: 'suite', ...common, identity: localized(entry.identity), dependencies: [...entry.dependencies], ...(entry.serviceAddresses?.length ? { serviceAddresses: [...entry.serviceAddresses] } : {}) }
    : { category: 'dependency', ...common }
}
