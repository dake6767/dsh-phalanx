import { expect, it } from 'vitest'
import { canonicalJson, readSuiteCatalogDocument, suiteCatalogContentHash, suiteCatalogSignedPayload, withSuiteCatalogContentHash, type UnsealedSuiteCatalogDocumentEntry } from '../src/domain/suite-catalog-document.js'
import { createCatalogSigningKey, signCatalog } from './fixtures/suite-catalog-signing.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

it('canonicalizes JSON deterministically: sorted keys, preserved arrays, UTF-8, no whitespace', () => {
  const first = canonicalJson({ z: 1, a: { b: [3, 1, 2], a: 'x' }, m: null })
  const second = canonicalJson({ a: { a: 'x', b: [3, 1, 2] }, m: null, z: 1 })
  expect(first).toBe(second)
  expect(first).toBe('{"a":{"a":"x","b":[3,1,2]},"m":null,"z":1}')
  expect(canonicalJson(['b', 'a'])).toBe('["b","a"]')
  expect(canonicalJson({ 'zh-CN': '套件', en: 'suite' })).toBe('{"en":"suite","zh-CN":"套件"}')
  expect(canonicalJson({ skip: undefined, keep: 1 })).toBe('{"keep":1}')
  expect(() => canonicalJson({ bad: Number.NaN })).toThrow()
})

it('hashes entry content without the hash member and detects any content change', () => {
  const entry = onlineCatalogEntries[0]!
  expect(suiteCatalogContentHash(entry)).toBe(entry.contentHash)
  const changed = { ...entry, description: { ...entry.description, en: 'changed' } }
  expect(suiteCatalogContentHash(changed)).not.toBe(entry.contentHash)
})

it('signs and parses a full document, ignoring unknown fields', () => {
  const key = createCatalogSigningKey()
  const fixture = signCatalog(onlineCatalogEntries, key)
  const parsed = readSuiteCatalogDocument(fixture.bytes)
  expect(parsed.okay).toBe(true)
  if (!parsed.okay) return
  expect(parsed.document.entries.map(entry => entry.id)).toEqual(['pandoc', 'ffmpeg', 'chromium', 'wecom'])
  const withExtra = JSON.parse(fixture.bytes.toString('utf8')) as { extra?: unknown, entries: { extra?: unknown }[] }
  withExtra.extra = { ignored: true }; withExtra.entries[0]!.extra = 'ignored'
  expect(readSuiteCatalogDocument(Buffer.from(JSON.stringify(withExtra))).okay).toBe(true)
})

it('rejects malformed JSON, unknown formats and invalid structures', () => {
  expect(readSuiteCatalogDocument(Buffer.from('{'))).toMatchObject({ okay: false, rejection: 'invalid-json' })
  expect(readSuiteCatalogDocument(Buffer.from(JSON.stringify({ format: 2, publishedAt: '2026-10-18T00:00:00Z', entries: [], signature: { keyId: 'k', signature: 's' } }))))
    .toMatchObject({ okay: false, rejection: 'unsupported-format' })
  const key = createCatalogSigningKey()
  const fixture = signCatalog(onlineCatalogEntries, key)
  const mutate = (change: (document: Record<string, unknown>) => void) => {
    const document = JSON.parse(fixture.bytes.toString('utf8')) as Record<string, unknown>
    change(document)
    return readSuiteCatalogDocument(Buffer.from(JSON.stringify(document)))
  }
  expect(mutate(document => { document.entries = [] })).toMatchObject({ okay: false, rejection: 'invalid-structure' })
  expect(mutate(document => { document.publishedAt = 'not-a-date' })).toMatchObject({ okay: false, rejection: 'invalid-structure' })
  expect(mutate(document => { (document.entries as { version: string }[])[0]!.version = '1' })).toMatchObject({ okay: false, rejection: 'invalid-structure' })
  expect(mutate(document => { (document.entries as { contentHash: string }[])[0]!.contentHash = 'short' })).toMatchObject({ okay: false, rejection: 'invalid-structure' })
  expect(mutate(document => { ((document.entries as { items: { version?: string }[] }[])[0]!.items as { kind: string }[])[0]!.kind = 'script' })).toMatchObject({ okay: false, rejection: 'invalid-structure' })
})

it('excludes the signature member from the signed payload', () => {
  const key = createCatalogSigningKey()
  const fixture = signCatalog(onlineCatalogEntries, key)
  const { signature, ...unsigned } = fixture.document
  expect(suiteCatalogSignedPayload(fixture.document).equals(Buffer.from(canonicalJson(unsigned), 'utf8'))).toBe(true)
  expect(signature.keyId).toBe(key.keyId)
})

it('seals entries with a verifiable content hash', () => {
  const unsealed: UnsealedSuiteCatalogDocumentEntry = {
    kind: 'dependency', id: 'tool', version: '1.2.3', engines: { platform: '>=0.1.18' }, adapters: [],
    title: { en: 'Tool', 'zh-CN': '工具' }, description: { en: 'A tool', 'zh-CN': '一个工具' }, source: { en: 'fixture', 'zh-CN': '夹具' },
    items: [{ kind: 'runtime-dependency', name: 'tool', paths: ['bin'], commands: ['tool'], downloads: [{ source: 'npm', packages: ['tool@1.2.3'] }] }],
  }
  const sealed = withSuiteCatalogContentHash(unsealed)
  expect(sealed.contentHash).toMatch(/^[0-9a-f]{64}$/u)
  expect(withSuiteCatalogContentHash(unsealed).contentHash).toBe(sealed.contentHash)
})
