import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { credentialTokenHelper, suiteCatalogAdapterWrappers, validateSuiteCatalogAdapters, type ValidatedSuiteCatalogAdapter } from '../../src/domain/suite-catalog-adapters.js'
import type { SuiteCatalogAdapterCall, SuiteCatalogDocumentEntry, SuiteCatalogRuntimeDependencyItem } from '../../src/domain/suite-catalog-document.js'
import { readSuiteCatalog, suiteAdapterValidationContext } from '../../src/domain/suite-catalog-reader.js'
import type { SuiteCatalogEntry } from '../../src/domain/suite-catalog.js'
import { createCatalogSigningKey, signCatalog } from './suite-catalog-signing.js'
import { onlineCatalogEntries } from './suite-catalog-online.js'

const key = createCatalogSigningKey()

/** The signed fixture catalog, read through the production trust boundary. */
export function fixtureCatalog(): readonly SuiteCatalogEntry[] {
  const read = readSuiteCatalog(signCatalog(onlineCatalogEntries, key).bytes, { trustedKeys: [key], platformVersion: '0.1.19' })
  if (read.status !== 'ok') throw new Error('fixture catalog was rejected')
  return read.entries.map(row => row.entry)
}

export function fixtureEntry(id: string): SuiteCatalogEntry {
  const entry = fixtureCatalog().find(row => row.id === id)
  if (!entry) throw new Error(`missing fixture entry ${id}`)
  return entry
}

/** The declarative document entry (still carrying adapters/service declarations). */
export function documentEntry(id: string): SuiteCatalogDocumentEntry {
  const entry = onlineCatalogEntries.find(row => row.id === id)
  if (!entry) throw new Error(`missing fixture document entry ${id}`)
  return entry
}

export function documentAdapters(id: string): readonly SuiteCatalogAdapterCall[] {
  const entry = documentEntry(id)
  if (entry.kind !== 'suite' && entry.kind !== 'dependency') throw new Error('reserved kind')
  return entry.adapters
}

export function documentRuntimeItem(id: string, itemName: string): SuiteCatalogRuntimeDependencyItem {
  const entry = documentEntry(id)
  if (entry.kind !== 'suite' && entry.kind !== 'dependency') throw new Error('reserved kind')
  const item = entry.items.find((row): row is SuiteCatalogRuntimeDependencyItem => row.kind === 'runtime-dependency' && row.name === itemName)
  if (!item) throw new Error(`missing fixture runtime item ${itemName}`)
  return item
}

export function validatedAdapters(id: string, itemName: string): readonly ValidatedSuiteCatalogAdapter[] {
  const document = documentEntry(id)
  if (document.kind !== 'suite' && document.kind !== 'dependency') throw new Error('reserved kind')
  // Build the context through the reader's own derivation so fixture-only rules cannot drift from production.
  const result = validateSuiteCatalogAdapters(documentAdapters(id), [documentRuntimeItem(id, itemName)], suiteAdapterValidationContext(document))
  if (!result.okay) throw new Error(`${result.code}: ${result.detail}`)
  return result.adapters
}

/** Writes the generated wrapper (and token helper, when present) exactly as preparation would. */
export async function writeGeneratedWrapper(root: string, id: string, itemName: string, command: string): Promise<{ readonly path: string, readonly lines: readonly string[] }> {
  const item = documentRuntimeItem(id, itemName)
  const adapters = validatedAdapters(id, itemName)
  const wrapper = suiteCatalogAdapterWrappers(item, adapters).find(row => row.command === command)
  if (!wrapper) throw new Error(`no generated wrapper for ${command}`)
  await mkdir(dirname(join(root, wrapper.path)), { recursive: true })
  const token = adapters.find((adapter): adapter is Extract<ValidatedSuiteCatalogAdapter, { kind: 'credential-token' }> => adapter.kind === 'credential-token')
  if (token) await writeFile(join(root, item.paths[0]!, `.platform-token-${command}.mjs`), `${credentialTokenHelper(token).join('\n')}\n`, { mode: 0o644 })
  await writeFile(join(root, wrapper.path), `${wrapper.lines.join('\n')}\n`, { mode: 0o755 })
  await chmod(join(root, wrapper.path), 0o755)
  return { path: join(root, wrapper.path), lines: wrapper.lines }
}
