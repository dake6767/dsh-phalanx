import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { mcpCatalogTarget } from '../src/domain/mcp-catalog-identity.js'
import { mcpPresets } from './fixtures/legacy-mcp-catalog.js'
import { signedMcpEntries } from './fixtures/mcp-catalog-online.js'
import { createCatalogSigningKey, signRawCatalog } from './fixtures/suite-catalog-signing.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

it('preserves the two first-party MCP templates and lets older platforms still read suite entries', () => {
  const publication = process.env.DSH_PHALANX_CATALOG_TEST_FILE
  const raw = publication
    ? JSON.parse(readFileSync(publication, 'utf8'))
    : { format: 1, publishedAt: '2026-11-17T00:00:00Z', entries: [...onlineCatalogEntries, ...signedMcpEntries()] }
  const key = createCatalogSigningKey()
  const signed = signRawCatalog(raw, key)
  const previous = readSuiteCatalog(signed, { platformVersion: '0.1.36', trustedKeys: [key] })
  const next = readSuiteCatalog(signed, { platformVersion: '0.1.37', trustedKeys: [key] })
  if (next.status !== 'ok' || previous.status !== 'ok') throw new Error('The signed catalog was rejected')
  expect(previous.skipped.map(row => row.id).sort()).toEqual(['12306', 'amap'])
  expect(next.entries.map(row => row.entry.id)).toEqual(previous.entries.map(row => row.entry.id))
  expect(next.mcp?.map(row => row.entry.id).sort()).toEqual(['12306', 'amap'])
  for (const legacy of mcpPresets) {
    const actual = next.mcp?.find(row => row.entry.id === legacy.entry.id)
    const saved = { ...legacy.configuration, name: 'p-copy', generation: 1, catalog: { id: legacy.entry.id, version: '1', status: 'ready' as const } }
    expect(actual).toMatchObject({
      configuration: legacy.configuration,
      entry: { title: legacy.entry.title, description: legacy.entry.description, documentation: legacy.entry.documentation },
    })
    expect(mcpCatalogTarget(saved, actual)).toBe('current')
    expect(mcpCatalogTarget({ ...saved, description: 'Different settings' }, actual)).toBe('update')
    expect(mcpCatalogTarget(saved, undefined)).toBe('unavailable')
  }
})
