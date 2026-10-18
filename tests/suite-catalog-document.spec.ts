import { expect, it } from 'vitest'
import { canonicalJson, normalizeSuiteCatalogDocument, parseSuiteCatalogJson, suiteCatalogContentHash, suiteCatalogSignedPayload, withSuiteCatalogContentHash, type UnsealedSuiteCatalogDocumentEntry } from '../src/domain/suite-catalog-document.js'
import { suitePrepareCommands } from '../src/domain/suite-prepare-commands.js'
import { createCatalogSigningKey, signCatalog } from './fixtures/suite-catalog-signing.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

/** Test-only convenience: parse then structurally normalize, exactly as the reader does after verification. */
const readSuiteCatalogDocument = (bytes: Uint8Array) => { const parsed = parseSuiteCatalogJson(bytes); return parsed.okay ? normalizeSuiteCatalogDocument(parsed.raw) : parsed }

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
  expect(parsed.document.entries.map(entry => entry.id)).toEqual(['pandoc', 'ffmpeg', 'chromium', 'wecom', 'officecli', 'minimax'])
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
  // An empty catalog is valid: the gallery renders its empty state instead of a rejection.
  expect(mutate(document => { document.entries = [] })).toMatchObject({ okay: true, document: { entries: [] } })
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

it('validates declared runtime service addresses', () => {
  const base = {
    kind: 'suite' as const, id: 'service-suite', version: '1.0.0', engines: { platform: '>=0.1.18' }, adapters: [],
    title: { en: 'Suite', 'zh-CN': '套件' }, description: { en: 'Suite', 'zh-CN': '套件' }, source: { en: 'fixture', 'zh-CN': '夹具' },
    identity: { en: 'Identity', 'zh-CN': '身份' }, dependencies: [], items: [],
  }
  const build = (serviceAddresses: string[]) => {
    const entries = [withSuiteCatalogContentHash({ ...base, serviceAddresses })]
    const document = { format: 1, publishedAt: '2026-10-18T00:00:00.000Z', entries, signature: { keyId: 'k', signature: 's' } }
    return readSuiteCatalogDocument(Buffer.from(JSON.stringify(document)))
  }
  expect(build(['https://api.example.test'])).toMatchObject({ okay: true })
  expect(build([])).toMatchObject({ okay: true })
  // A malformed declaration is caught while sealing the entry, before the document can be signed.
  expect(() => build(['ftp://api.example.test'])).toThrow('serviceAddresses')
  expect(() => build(['https://user:secret@api.example.test'])).toThrow('serviceAddresses')
  expect(() => build(['https://api.example.test/#fragment'])).toThrow('serviceAddresses')
})

it('rejects download locations that could inject shell syntax into generated commands', () => {
  const runtime = (url: string | Record<string, string>, source: 'github-assets' | 'browser' = 'github-assets'): UnsealedSuiteCatalogDocumentEntry => ({
    kind: 'dependency', id: 'download-safety', version: '1.0.0', engines: { platform: '>=0.1.18' }, adapters: [],
    title: { en: 'Tool', 'zh-CN': '工具' }, description: { en: 'Tool', 'zh-CN': '工具' }, source: { en: 'fixture', 'zh-CN': '夹具' },
    items: [{ kind: 'runtime-dependency', name: 'tool', paths: ['bin'], commands: ['tool'],
      downloads: [{ source, url, sha256: { amd64: 'a'.repeat(64), arm64: 'b'.repeat(64) }, target: 'tool.bin', ...(source === 'github-assets' ? { executable: true } : { extract: { format: 'none' as const } }) }] }],
  })
  // Shell-active characters never reach the double-quoted curl argument.
  for (const hostile of [
    'https://github.com/o/r/$(id)',
    'https://github.com/o/r/`id`',
    'https://github.com/o/r/tool;id',
    'https://github.com/o/r/tool|id',
    'https://github.com/o/r/tool\\id',
    'https://github.com/o/r/tool id',
    'https://github.com/o/r/tool\nid',
    'https://github.com/o/r/tool"id',
    'https://github.com/o/r/tool<id>',
    'https://github.com/o/r/{other}',
    'file:///etc/passwd',
  ]) expect(() => withSuiteCatalogContentHash(runtime(hostile)), hostile).toThrow()
  for (const hostile of ['builds/$(id).zip', 'builds/`id`.zip', 'builds/a b.zip', 'builds/../escape.zip', '/absolute/builds/x.zip'])
    expect(() => withSuiteCatalogContentHash(runtime(hostile, 'browser')), hostile).toThrow()
  // Ordinary URLs, including query strings and percent escapes, still pass and generate a safe command.
  const safe = withSuiteCatalogContentHash(runtime('https://github.com/o/r/releases/download/v1/tool-{arch}.bin?x=1&y=a%20b'))
  if (safe.kind !== 'dependency') throw new Error('unexpected entry kind')
  const item = safe.items[0]!
  if (item.kind !== 'runtime-dependency') throw new Error('unexpected item')
  const command = suitePrepareCommands(item).amd64!
  expect(command).toContain('https://github.com/o/r/releases/download/v1/tool-amd64.bin?x=1&y=a%20b')
  expect(command).not.toContain('$(')
})

it('signs and hashes the received JSON object without normalizing unknown members', async () => {
  const key = createCatalogSigningKey()
  // A suite that omits optional serviceAddresses is signed exactly as written; no default is inserted before hashing.
  const suite = withSuiteCatalogContentHash({ kind: 'suite', id: 'plain-suite', version: '1.0.0', engines: { platform: '>=0.1.18' }, adapters: [],
    title: { en: 'Suite', 'zh-CN': '套件' }, description: { en: 'Suite', 'zh-CN': '套件' }, source: { en: 'fixture', 'zh-CN': '夹具' },
    identity: { en: 'Identity', 'zh-CN': '身份' }, dependencies: [], items: [] } as UnsealedSuiteCatalogDocumentEntry)
  expect('serviceAddresses' in suite).toBe(false)
  const unknownEntry = { ...suite, futureField: { nested: [1, 2, 3] } }
  const unknownTop = { format: 1, publishedAt: '2026-10-18T00:00:00.000Z', entries: [unknownEntry], futureTop: 'kept' }
  const handwritten = Buffer.from(JSON.stringify({ ...unknownTop, signature: { keyId: key.keyId, signature: 'pending' } }))
  // A publisher that signs the JSON it wrote, without normalization, still verifies.
  const { sign } = await import('node:crypto')
  const payload = suiteCatalogSignedPayload(unknownTop)
  const signature = sign(null, payload, key.privateKey).toString('base64')
  const document = { ...unknownTop, signature: { keyId: key.keyId, signature } }
  expect(readSuiteCatalogDocument(Buffer.from(JSON.stringify(document)))).toMatchObject({ okay: true })
  expect(handwritten.length).toBeGreaterThan(0)
})

it('keeps registry package specs shell-inert and requires exact pins at runtime', () => {
  const registry = (packages: string[], source: 'npm' | 'pypi' = 'npm'): UnsealedSuiteCatalogDocumentEntry => ({
    kind: 'dependency', id: 'registry-spec', version: '1.0.0', engines: { platform: '>=0.1.18' }, adapters: [],
    title: { en: 'Tool', 'zh-CN': '工具' }, description: { en: 'Tool', 'zh-CN': '工具' }, source: { en: 'fixture', 'zh-CN': '夹具' },
    items: [{ kind: 'runtime-dependency', name: 'tool', paths: ['bin'], commands: ['tool'], downloads: [{ source, packages }] }],
  })
  expect(() => withSuiteCatalogContentHash(registry(['tool@1.2.3']))).not.toThrow()
  expect(() => withSuiteCatalogContentHash(registry(['@scope/tool@1.2.3']))).not.toThrow()
  // Structural rejection of shell-active or range syntax; the runtime check rejects unpinned packages later.
  for (const spec of ['tool@^1.2.3', 'tool@~1.2.3', 'tool@*', 'tool@>=1.2.3', 'tool@1.2.3 $(id)', 'tool;id']) expect(() => withSuiteCatalogContentHash(registry([spec])), spec).toThrow()
  expect(() => withSuiteCatalogContentHash(registry(['tool==1.0.0'], 'pypi'))).not.toThrow()
  expect(() => withSuiteCatalogContentHash(registry(['tool>=1.0.0'], 'pypi'))).toThrow()
})

it('rejects a document that names the same entry id twice', () => {
  const entry = onlineCatalogEntries[0]!
  const document = { format: 1, publishedAt: '2026-10-18T00:00:00.000Z', entries: [entry, entry], signature: { keyId: 'k', signature: 's' } }
  expect(readSuiteCatalogDocument(Buffer.from(JSON.stringify(document)))).toMatchObject({ okay: false, rejection: 'invalid-structure', detail: 'entries: duplicate id' })
})
