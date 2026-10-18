import { expect, it } from 'vitest'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { suiteRuntimeDependencyDefinition, type SuiteCatalogRuntimeDependencyItem } from '../src/domain/suite-catalog.js'
import { suiteCatalogContentHash, withSuiteCatalogContentHash, type UnsealedSuiteCatalogDocumentEntry } from '../src/domain/suite-catalog-document.js'
import { officialSuiteCatalogKeys } from '../src/domain/suite-catalog-keys.js'
import { createCatalogSigningKey, signCatalog, signRawCatalog, type CatalogSigningKey } from './fixtures/suite-catalog-signing.js'
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
  expect(result.entries.map(row => row.entry.id)).toEqual(['pandoc', 'ffmpeg', 'chromium', 'wecom', 'officecli', 'minimax', 'lark', 'hyperframes'])
  for (const row of result.entries) expect(row.contentHash).toBe(row.entry.contentHash)
  const byId = new Map(result.entries.map(row => [row.entry.id, row.entry]))
  const wecom = byId.get('wecom')!
  expect(wecom).toMatchObject({ category: 'suite', dependencies: [], version: '2.0.0' })
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
  // A structurally invalid document that is correctly signed still fails structural validation after verification.
  const unsigned = JSON.parse(fixture.bytes.toString('utf8')) as Record<string, unknown>
  delete unsigned.signature
  unsigned.entries = [{ id: 'x' }]
  expect(readSuiteCatalog(signRawCatalog(unsigned, key), options)).toMatchObject({ status: 'rejected', reason: 'invalid-document' })
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
  const adapter = withSuiteCatalogContentHash(minimal({ id: 'adapter', adapters: [{ name: 'secret-adapter', params: {} }] }))
  const compatible = onlineCatalogEntries.find(row => row.id === 'pandoc')!
  const result = readSuiteCatalog(signCatalog([compatible, newer, adapter], key).bytes, options)
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(result.entries.map(row => [row.entry.id, row.entry.unavailableReason])).toEqual([['pandoc', undefined], ['newer', 'needs-platform-upgrade'], ['adapter', 'unknown-adapter']])
  expect(result.rejected).toEqual([
    { id: 'newer', version: '1.0.0', reason: 'needs-platform-upgrade', detail: '>=999.0.0' },
    { id: 'adapter', version: '1.0.0', reason: 'unknown-adapter', detail: 'adapters[0]: secret-adapter' },
  ])
})

it('skips reserved entry kinds before compatibility rules and records them in the log result', () => {
  // Even an adapter this platform does not know and an unreachable platform range are skipped, not rejected.
  const plugin = withSuiteCatalogContentHash({ kind: 'plugin', id: 'reserved-plugin', version: '1.0.0', engines: { platform: '>=999.0.0' }, adapters: [{ name: 'unknown-adapter', params: {} }],
    title: { en: 'Plugin', 'zh-CN': '插件' }, description: { en: 'Plugin', 'zh-CN': '插件' }, source: { en: 'fixture', 'zh-CN': '夹具' } } as UnsealedSuiteCatalogDocumentEntry)
  const result = readSuiteCatalog(signCatalog([plugin, ...onlineCatalogEntries], key).bytes, options)
  expect(result).toMatchObject({ status: 'ok', skipped: [{ id: 'reserved-plugin', kind: 'plugin' }], rejected: [] })
  if (result.status === 'ok') expect(result.entries.map(row => row.entry.id)).toEqual(['pandoc', 'ffmpeg', 'chromium', 'wecom', 'officecli', 'minimax', 'lark', 'hyperframes'])
})

it('ships the official key and refuses catalogs signed by a test fixture', () => {
  expect(officialSuiteCatalogKeys).toHaveLength(1)
  expect(officialSuiteCatalogKeys[0]!.keyId).toMatch(/^official-[a-f0-9]{16}$/u)
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

it('verifies the signature over the received JSON, including unknown members, and hashes them too', () => {
  const signingKey = createCatalogSigningKey()
  const base = onlineCatalogEntries.find(row => row.id === 'pandoc')!
  const sealedWithUnknown = withSuiteCatalogContentHash({ ...(base as object), futureField: { nested: [1, 2] } } as never)
  const verified = readSuiteCatalog(signCatalog([sealedWithUnknown], signingKey).bytes, { trustedKeys: [signingKey], platformVersion: '0.1.19' })
  expect(verified.status).toBe('ok')
  if (verified.status === 'ok') expect(verified.entries.map(row => row.entry.id)).toEqual(['pandoc'])

  // The content hash covers unknown members: a publisher that hashes without them is refused.
  const sealedWithoutUnknown = withSuiteCatalogContentHash(base as never)
  const smuggled = { ...sealedWithoutUnknown, futureField: 'not covered by the declared hash' }
  expect(readSuiteCatalog(signCatalog([smuggled], signingKey).bytes, { trustedKeys: [signingKey], platformVersion: '0.1.19' }))
    .toMatchObject({ status: 'ok', rejected: [{ id: 'pandoc', reason: 'content-hash-mismatch' }] })

  // Tampering with a signed top-level field breaks the signature.
  const document = JSON.parse(signCatalog([sealedWithUnknown], signingKey).bytes.toString('utf8')) as Record<string, unknown>
  document.publishedAt = '2030-01-01T00:00:00.000Z'
  expect(readSuiteCatalog(Buffer.from(JSON.stringify(document)), { trustedKeys: [signingKey], platformVersion: '0.1.19' })).toMatchObject({ status: 'rejected', reason: 'invalid-signature' })
})

it('accepts a handwritten document signed as written, including a suite without optional service addresses', () => {
  const signingKey = createCatalogSigningKey()
  const rawEntry: Record<string, unknown> = {
    kind: 'suite', id: 'handmade', version: '2.0.0', engines: { platform: '>=0.1.18' }, adapters: [],
    title: { en: 'Handmade', 'zh-CN': '手写' }, description: { en: 'Handmade', 'zh-CN': '手写' }, source: { en: 'fixture', 'zh-CN': '夹具' },
    identity: { en: 'Identity', 'zh-CN': '身份' }, dependencies: [], items: [],
    // optional serviceAddresses is deliberately absent
  }
  rawEntry.contentHash = suiteCatalogContentHash(rawEntry)
  const bytes = signRawCatalog({ format: 1, publishedAt: '2026-10-18T00:00:00.000Z', entries: [rawEntry] }, signingKey)
  const result = readSuiteCatalog(bytes, { trustedKeys: [signingKey], platformVersion: '0.1.19' })
  expect(result).toMatchObject({ status: 'ok', rejected: [] })
  if (result.status === 'ok') expect(result.entries[0]!.entry).toMatchObject({ id: 'handmade', category: 'suite', version: '2.0.0' })
})

it('accepts an empty catalog so the gallery can show its empty state', () => {
  const signingKey = createCatalogSigningKey()
  const result = readSuiteCatalog(signCatalog([], signingKey).bytes, { trustedKeys: [signingKey], platformVersion: '0.1.19' })
  expect(result).toMatchObject({ status: 'ok', entries: [], rejected: [], skipped: [] })
})

it('refuses a signed entry that fails the platform download checks at runtime', () => {
  const signingKey = createCatalogSigningKey()
  const unpinned = withSuiteCatalogContentHash(minimal({
    items: [{ kind: 'runtime-dependency', name: 'fixture-tool', paths: ['node_modules/.bin'], commands: ['fixture-tool'],
      downloads: [{ source: 'npm', packages: ['fixture-tool'] }] }],
  }))
  const result = readSuiteCatalog(signCatalog([unpinned], signingKey).bytes, { trustedKeys: [signingKey], platformVersion: '0.1.19' })
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(result.entries[0]!.entry).toMatchObject({ unavailableReason: 'invalid-entry' })
  expect(result.entries[0]!.unavailableDetail).toContain('must pin an exact version')
  expect(result.rejected).toEqual([{ id: 'fixture-tool', version: '1.0.0', reason: 'invalid-entry', detail: expect.stringContaining('must pin an exact version') }])
})

it('rejects a single entry with invalid adapter parameters without rejecting the document', () => {
  const invalid = withSuiteCatalogContentHash(minimal({ id: 'bad-adapter', adapters: [{ name: 'fixed-environment', params: { item: 'missing', command: 'tool', environment: { A: '1' } } }] }))
  const compatible = onlineCatalogEntries.find(row => row.id === 'pandoc')!
  const result = readSuiteCatalog(signCatalog([compatible, invalid], key).bytes, options)
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(result.entries.map(row => [row.entry.id, row.entry.unavailableReason])).toEqual([['pandoc', undefined], ['bad-adapter', 'invalid-adapter-params']])
  expect(result.rejected).toEqual([{ id: 'bad-adapter', version: '1.0.0', reason: 'invalid-adapter-params', detail: 'fixed-environment needs an existing item and command' }])
})

it('reports a newer platform requirement before unknown adapters', () => {
  const future = minimal({ id: 'future-adapter-entry', engines: { platform: '>=99.0.0' }, adapters: [{ name: 'not-a-known-adapter', params: {} }] })
  const read = readSuiteCatalog(signCatalog([withSuiteCatalogContentHash(future)], key).bytes, options)
  expect(read.status).toBe('ok')
  if (read.status !== 'ok') return
  expect(read.rejected[0]).toMatchObject({ id: 'future-adapter-entry', reason: 'needs-platform-upgrade' })
  expect(read.entries[0]).toMatchObject({ unavailableReason: 'needs-platform-upgrade', entry: { unavailableReason: 'needs-platform-upgrade' } })
  // On a platform that satisfies the range the same entry reports the unknown adapter instead.
  const current = minimal({ id: 'unknown-adapter-entry', engines: { platform: '>=0.1.18' }, adapters: [{ name: 'not-a-known-adapter', params: {} }] })
  const currentRead = readSuiteCatalog(signCatalog([withSuiteCatalogContentHash(current)], key).bytes, options)
  if (currentRead.status !== 'ok') throw new Error('fixture catalog was rejected')
  expect(currentRead.rejected[0]).toMatchObject({ id: 'unknown-adapter-entry', reason: 'unknown-adapter' })
})

it('rejects malformed adapter call shapes as a structural document error', () => {
  const good = withSuiteCatalogContentHash(minimal()) as unknown as Record<string, unknown>
  for (const adapters of [[{ name: 'only-a-name' }], [{ params: {} }], [{ name: 'bad name', params: {} }], 'not-a-list', [{ name: 'fixed-environment', params: [] }]]) {
    const raw = signRawCatalog({ format: 1, publishedAt: '2026-10-18T00:00:00.000Z', entries: [{ ...good, adapters }] }, key)
    expect(readSuiteCatalog(raw, options), JSON.stringify(adapters)).toMatchObject({ status: 'rejected', reason: 'invalid-document' })
  }
  // A well-shaped call with an unknown adapter name is still a single-entry rejection.
  const unknown = withSuiteCatalogContentHash(minimal({ id: 'unknown-shape', adapters: [{ name: 'unknown-adapter', params: {} }] }))
  const read = readSuiteCatalog(signCatalog([unknown], key).bytes, options)
  if (read.status !== 'ok') throw new Error('fixture catalog was rejected')
  expect(read.rejected[0]).toMatchObject({ id: 'unknown-shape', reason: 'unknown-adapter' })
})
