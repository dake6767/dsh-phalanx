import { expect, it } from 'vitest'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { suiteRuntimeDependencyDefinition, type SuiteCatalogRuntimeDependencyItem } from '../src/domain/suite-catalog.js'
import { withSuiteCatalogContentHash, type UnsealedSuiteCatalogDocumentEntry } from '../src/domain/suite-catalog-document.js'
import { officialSuiteCatalogKeys } from '../src/domain/suite-catalog-keys.js'
import { createCatalogSigningKey, signCatalog, type CatalogSigningKey } from './fixtures/suite-catalog-signing.js'
import { legacyPrepareCommands, onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

const key = createCatalogSigningKey()
const options = { trustedKeys: [key], platformVersion: '0.1.19' }
const minimal = (overrides: Partial<UnsealedSuiteCatalogDocumentEntry> = {}): UnsealedSuiteCatalogDocumentEntry => ({
  kind: 'dependency', id: 'fixture-tool', version: '1.0.0', engines: { platform: '>=0.1.18' }, adapters: [],
  title: { en: 'Fixture tool', 'zh-CN': '夹具工具' }, description: { en: 'Fixture', 'zh-CN': '夹具' }, source: { en: 'fixture', 'zh-CN': '夹具' },
  items: [{ kind: 'runtime-dependency', name: 'fixture-tool', paths: ['bin'], commands: ['fixture-tool'], downloads: [{ source: 'npm', packages: ['fixture-tool@1.0.0'] }] }],
  ...overrides,
} as UnsealedSuiteCatalogDocumentEntry)

it('returns converted entries with platform-generated preparation for a valid signed catalog', () => {
  const result = readSuiteCatalog(signCatalog(onlineCatalogEntries, key).bytes, options)
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(result.entries.map(row => row.entry.id)).toEqual(['pandoc', 'ffmpeg', 'chromium', 'wecom'])
  for (const row of result.entries) expect(row.contentHash).toBe(row.entry.contentHash)
  const byId = new Map(result.entries.map(row => [row.entry.id, row.entry]))
  const wecom = byId.get('wecom')!
  expect(wecom).toMatchObject({ category: 'suite', dependencies: [], version: '1.0.0' })
  for (const id of ['pandoc', 'ffmpeg', 'chromium']) {
    const item = byId.get(id)!.items.find((row): row is SuiteCatalogRuntimeDependencyItem => row.kind === 'runtime-dependency')!
    for (const architecture of ['amd64', 'arm64'] as const) {
      const expected = id === 'pandoc' ? `set -eu\n${legacyPrepareCommands.pandoc![architecture].split(' && ').join('\n')}` : legacyPrepareCommands[id]![architecture]
      expect(suiteRuntimeDependencyDefinition(item, architecture)?.prepareCommand).toBe(expected)
    }
  }
  expect(result.rejected).toEqual([]); expect(result.skipped).toEqual([])
})

it('rejects the whole catalog for unreadable bytes, an unknown format, an unknown key and a bad signature', () => {
  expect(readSuiteCatalog(Buffer.from('not json'), options)).toMatchObject({ status: 'rejected', reason: 'invalid-document' })
  expect(readSuiteCatalog(Buffer.from(JSON.stringify({ format: 99, publishedAt: '2026-10-18T00:00:00Z', entries: [], signature: { keyId: 'k', signature: 's' } })), options))
    .toMatchObject({ status: 'rejected', reason: 'unsupported-format' })
  const fixture = signCatalog(onlineCatalogEntries, key)
  expect(readSuiteCatalog(fixture.bytes, { ...options, trustedKeys: [createCatalogSigningKey('other-key')] })).toMatchObject({ status: 'rejected', reason: 'unknown-key' })
  const tampered = JSON.parse(fixture.bytes.toString('utf8')) as { entries: { description: { en: string } }[] }
  tampered.entries[0]!.description.en = 'tampered'
  expect(readSuiteCatalog(Buffer.from(JSON.stringify(tampered)), options)).toMatchObject({ status: 'rejected', reason: 'invalid-signature' })
  const badStructure = JSON.parse(fixture.bytes.toString('utf8')) as { entries: unknown[] }
  badStructure.entries = [{ id: 'x' }]
  expect(readSuiteCatalog(Buffer.from(JSON.stringify(badStructure)), options)).toMatchObject({ status: 'rejected', reason: 'invalid-document' })
})

it('rejects a single entry when its declared content hash does not match its content', () => {
  const stale = onlineCatalogEntries[0]!
  const unsigned = { ...stale, description: { ...stale.description, en: 'changed without resealing' } }
  const result = readSuiteCatalog(signCatalog([unsigned], key).bytes, options)
  expect(result).toMatchObject({ status: 'ok', rejected: [{ id: 'pandoc', reason: 'content-hash-mismatch' }] })
  if (result.status === 'ok') expect(result.entries).toMatchObject([{ entry: { id: 'pandoc', unavailableReason: 'content-hash-mismatch' }, unavailableReason: 'content-hash-mismatch' }])
})

it('marks entries that need a newer platform and entries that reference unknown adapters, without rejecting the rest', () => {
  const newer = withSuiteCatalogContentHash(minimal({ id: 'newer', engines: { platform: '>=999.0.0' } }))
  const adapter = withSuiteCatalogContentHash(minimal({ id: 'adapter', adapters: ['secret-adapter'] }))
  const compatible = onlineCatalogEntries.find(row => row.id === 'pandoc')!
  const result = readSuiteCatalog(signCatalog([compatible, newer, adapter], key).bytes, options)
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(result.entries.map(row => [row.entry.id, row.entry.unavailableReason])).toEqual([['pandoc', undefined], ['newer', 'needs-platform-upgrade'], ['adapter', 'unknown-adapter']])
  expect(result.rejected).toEqual([
    { id: 'newer', version: '1.0.0', reason: 'needs-platform-upgrade', detail: '>=999.0.0' },
    { id: 'adapter', version: '1.0.0', reason: 'unknown-adapter', detail: 'secret-adapter' },
  ])
})

it('skips reserved entry kinds and records them in the log result', () => {
  const plugin = withSuiteCatalogContentHash({ ...minimal({ id: 'reserved-plugin', kind: 'plugin' }), kind: 'plugin' } as UnsealedSuiteCatalogDocumentEntry)
  const result = readSuiteCatalog(signCatalog([plugin, ...onlineCatalogEntries], key).bytes, options)
  expect(result).toMatchObject({ status: 'ok', skipped: [{ id: 'reserved-plugin', kind: 'plugin' }] })
  if (result.status === 'ok') expect(result.entries.map(row => row.entry.id)).toEqual(['pandoc', 'ffmpeg', 'chromium', 'wecom'])
})

it('ships exactly one placeholder official key that no test fixture trusts', () => {
  expect(officialSuiteCatalogKeys).toHaveLength(1)
  expect(officialSuiteCatalogKeys[0]!.keyId).toMatch(/^official-placeholder-/u)
  expect(officialSuiteCatalogKeys.some(row => row.keyId === key.keyId)).toBe(false)
  const fixture = signCatalog(onlineCatalogEntries, key)
  expect(readSuiteCatalog(fixture.bytes, { platformVersion: '0.1.19', trustedKeys: officialSuiteCatalogKeys })).toMatchObject({ status: 'rejected', reason: 'unknown-key' })
})

it('exposes the documented read options shape for keys and platform version', () => {
  const trusted: CatalogSigningKey = key
  expect(options.trustedKeys[0]).toMatchObject({ keyId: trusted.keyId })
  expect(typeof options.platformVersion).toBe('string')
})

it('passes declared runtime service addresses through to the platform entry', () => {
  const entry = withSuiteCatalogContentHash({ ...(onlineCatalogEntries.find(row => row.id === 'wecom') as never as Record<string, unknown>), serviceAddresses: ['https://qyapi.weixin.qq.com'] } as never)
  const result = readSuiteCatalog(signCatalog([entry], key).bytes, options)
  expect(result.status).toBe('ok')
  if (result.status === 'ok') expect(result.entries[0]!.entry).toMatchObject({ category: 'suite', serviceAddresses: ['https://qyapi.weixin.qq.com'] })
})
