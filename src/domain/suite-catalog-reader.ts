import { normalizeSuiteCatalogDocument, parseSuiteCatalogJson, suiteCatalogContentHash, suiteCatalogFormat, type SuiteCatalogDocumentDependencyEntry, type SuiteCatalogDocumentEntry, type SuiteCatalogDocumentSuiteEntry, type SuiteCatalogItem as SuiteCatalogDocumentItem, type SuiteCatalogLocalized } from './suite-catalog-document.js'
import { knownSuiteCatalogAdapters, verifySuiteCatalogSignature, type TrustedSuiteCatalogKey } from './suite-catalog-signature.js'
import { suiteEntryViolations } from './suite-catalog-checks.js'
import type { SuiteCatalogEntry, SuiteCatalogItem } from './suite-catalog.js'
import { suitePrepareCheckCommand, suitePrepareCommands } from './suite-prepare-commands.js'
import { satisfiesSemverRange } from './semver.js'

/** Entries the reader refused; the gallery shows them unavailable with the reason. */
export type SuiteCatalogEntryRejection = 'needs-platform-upgrade' | 'unknown-adapter' | 'content-hash-mismatch' | 'invalid-entry'
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
    const problem = entryProblem(entry, rawEntries[index], options.platformVersion)
    if (problem) rejected.push({ id: entry.id, version: entry.version, reason: problem.reason, ...(problem.detail ? { detail: problem.detail } : {}) })
    entries.push({ entry: { ...convertEntry(entry), ...(problem ? { unavailableReason: problem.reason } : {}), ...(problem?.detail ? { unavailableDetail: problem.detail } : {}) },
      contentHash: entry.contentHash, ...(problem ? { unavailableReason: problem.reason } : {}), ...(problem?.detail ? { unavailableDetail: problem.detail } : {}) })
  })
  return { status: 'ok', publishedAt: normalized.document.publishedAt, entries, rejected, skipped }
}

function entryProblem(entry: SuiteCatalogDocumentDependencyEntry | SuiteCatalogDocumentSuiteEntry, rawEntry: unknown, platformVersion: string): { readonly reason: SuiteCatalogEntryRejection, readonly detail?: string } | undefined {
  if (typeof rawEntry !== 'object' || rawEntry === null || suiteCatalogContentHash(rawEntry) !== entry.contentHash) return { reason: 'content-hash-mismatch' }
  const unknown = entry.adapters.filter(adapter => !knownSuiteCatalogAdapters().includes(adapter))
  if (unknown.length) return { reason: 'unknown-adapter', detail: unknown.join(', ') }
  if (!satisfiesSemverRange(platformVersion, entry.engines.platform)) return { reason: 'needs-platform-upgrade', detail: entry.engines.platform }
  // The catalog rules run at runtime too, so a signed entry cannot bypass download-source prefixes, checksums or pins.
  const violations = suiteEntryViolations(convertEntry(entry))
  if (violations.length) return { reason: 'invalid-entry', detail: violations.join('; ') }
  return undefined
}

function localized(value: SuiteCatalogLocalized): Readonly<Record<'en' | 'zh-CN', string>> { return { en: value.en, 'zh-CN': value['zh-CN'] } }

function convertItem(item: SuiteCatalogDocumentItem): SuiteCatalogItem {
  if (item.kind === 'runtime-dependency') {
    const check = suitePrepareCheckCommand(item)
    return { kind: 'runtime-dependency', name: item.name, prepareCommands: suitePrepareCommands(item), pathDirectories: [...item.paths], commands: [...item.commands],
      ...(check ? { checkCommand: check } : {}) }
  }
  if (item.kind === 'skill') return { kind: 'skill', source: { ...item.source }, names: [...item.names],
    ...(item.runtimeDependency ? { runtimeDependency: item.runtimeDependency } : {}), ...(item.catalogDependencies ? { catalogDependencies: [...item.catalogDependencies] } : {}) }
  if (item.kind === 'skill-pack') return { kind: 'skill-pack', name: item.name, description: item.description, note: item.note, skills: [...item.skills] }
  return { kind: 'execution', skill: item.skill, runtimeDependency: item.runtimeDependency,
    delegated: item.delegated.map(row => ({ command: row.command, blocked: [...row.blocked] })),
    variables: item.variables.map(row => ({ name: row.name, purpose: localized(row.purpose) })) }
}

function convertEntry(entry: Extract<SuiteCatalogDocumentEntry, { kind: 'suite' | 'dependency' }>): SuiteCatalogEntry {
  const common = { id: entry.id, version: entry.version, contentHash: entry.contentHash, title: localized(entry.title), description: localized(entry.description), source: localized(entry.source),
    items: entry.items.map(convertItem) }
  return entry.kind === 'suite'
    ? { category: 'suite', ...common, identity: localized(entry.identity), dependencies: [...entry.dependencies], ...(entry.serviceAddresses?.length ? { serviceAddresses: [...entry.serviceAddresses] } : {}) }
    : { category: 'dependency', ...common }
}
