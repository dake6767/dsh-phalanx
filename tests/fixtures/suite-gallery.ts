import type { SuiteCatalogEntry } from '../../src/domain/suite-catalog.js'

/** Quick use-case seam: an already loaded gallery view, without network or signature I/O. */
export function fixtureGallery(entries: readonly SuiteCatalogEntry[]) {
  const source = { status: 'ok' as const, address: 'https://catalog.example.test/catalog.json' }
  return { entries: () => entries, source: () => source, load: async () => source }
}
