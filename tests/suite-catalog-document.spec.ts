import { expect, it } from 'vitest'
import {
  canonicalJson,
  normalizeSuiteCatalogDocument,
  parseSuiteCatalogJson,
  suiteCatalogContentHash,
  suiteCatalogSignedPayload,
  withSuiteCatalogContentHash,
  type UnsealedSuiteCatalogDocumentEntry,
} from '../src/domain/suite-catalog-document.js'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { suiteRuntimeDependencyDefinition } from '../src/domain/suite-catalog.js'
import { suitePrepareCommands } from '../src/domain/suite-prepare-commands.js'
import { createCatalogSigningKey, signCatalog } from './fixtures/suite-catalog-signing.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

/** Test-only convenience: parse then structurally normalize, exactly as the reader does after verification. */
const readSuiteCatalogDocument = (bytes: Uint8Array) => {
  const parsed = parseSuiteCatalogJson(bytes)
  return parsed.okay ? normalizeSuiteCatalogDocument(parsed.raw) : parsed
}

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
  expect(parsed.document.entries.map(entry => entry.id)).toEqual(['pandoc', 'ffmpeg', 'chromium', 'wecom', 'officecli', 'minimax', 'lark', 'hyperframes'])
  const withExtra = JSON.parse(fixture.bytes.toString('utf8')) as { extra?: unknown; entries: { extra?: unknown }[] }
  withExtra.extra = { ignored: true }
  withExtra.entries[0]!.extra = 'ignored'
  expect(readSuiteCatalogDocument(Buffer.from(JSON.stringify(withExtra))).okay).toBe(true)
})

it('rejects malformed JSON, unknown formats and invalid structures', () => {
  expect(readSuiteCatalogDocument(Buffer.from('{'))).toMatchObject({ okay: false, rejection: 'invalid-json' })
  expect(
    readSuiteCatalogDocument(
      Buffer.from(JSON.stringify({ format: 2, publishedAt: '2026-10-18T00:00:00Z', entries: [], signature: { keyId: 'k', signature: 's' } })),
    ),
  ).toMatchObject({ okay: false, rejection: 'unsupported-format' })
  const key = createCatalogSigningKey()
  const fixture = signCatalog(onlineCatalogEntries, key)
  const mutate = (change: (document: Record<string, unknown>) => void) => {
    const document = JSON.parse(fixture.bytes.toString('utf8')) as Record<string, unknown>
    change(document)
    return readSuiteCatalogDocument(Buffer.from(JSON.stringify(document)))
  }
  // An empty catalog is valid: the gallery renders its empty state instead of a rejection.
  expect(
    mutate(document => {
      document.entries = []
    }),
  ).toMatchObject({ okay: true, document: { entries: [] } })
  expect(
    mutate(document => {
      document.publishedAt = 'not-a-date'
    }),
  ).toMatchObject({ okay: false, rejection: 'invalid-structure' })
  expect(
    mutate(document => {
      ;(document.entries as { version: string }[])[0]!.version = '1'
    }),
  ).toMatchObject({ okay: false, rejection: 'invalid-structure' })
  expect(
    mutate(document => {
      ;(document.entries as { contentHash: string }[])[0]!.contentHash = 'short'
    }),
  ).toMatchObject({ okay: false, rejection: 'invalid-structure' })
  expect(
    mutate(document => {
      ;((document.entries as { items: { version?: string }[] }[])[0]!.items as { kind: string }[])[0]!.kind = 'script'
    }),
  ).toMatchObject({ okay: false, rejection: 'invalid-structure' })
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
    kind: 'dependency',
    id: 'tool',
    version: '1.2.3',
    engines: { platform: '>=0.1.18' },
    adapters: [],
    title: { en: 'Tool', 'zh-CN': '工具' },
    description: { en: 'A tool', 'zh-CN': '一个工具' },
    source: { en: 'fixture', 'zh-CN': '夹具' },
    items: [{ kind: 'runtime-dependency', name: 'tool', paths: ['bin'], commands: ['tool'], downloads: [{ source: 'npm', packages: ['tool@1.2.3'] }] }],
  }
  const sealed = withSuiteCatalogContentHash(unsealed)
  expect(sealed.contentHash).toMatch(/^[0-9a-f]{64}$/u)
  expect(withSuiteCatalogContentHash(unsealed).contentHash).toBe(sealed.contentHash)
})

it('validates declared runtime service addresses', () => {
  const base = {
    kind: 'suite' as const,
    id: 'service-suite',
    version: '1.0.0',
    engines: { platform: '>=0.1.18' },
    adapters: [],
    title: { en: 'Suite', 'zh-CN': '套件' },
    description: { en: 'Suite', 'zh-CN': '套件' },
    source: { en: 'fixture', 'zh-CN': '夹具' },
    identity: { en: 'Identity', 'zh-CN': '身份' },
    dependencies: [],
    items: [],
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
    kind: 'dependency',
    id: 'download-safety',
    version: '1.0.0',
    engines: { platform: '>=0.1.18' },
    adapters: [],
    title: { en: 'Tool', 'zh-CN': '工具' },
    description: { en: 'Tool', 'zh-CN': '工具' },
    source: { en: 'fixture', 'zh-CN': '夹具' },
    items: [
      {
        kind: 'runtime-dependency',
        name: 'tool',
        paths: ['bin'],
        commands: ['tool'],
        downloads: [
          {
            source,
            url,
            sha256: { amd64: 'a'.repeat(64), arm64: 'b'.repeat(64) },
            target: 'tool.bin',
            ...(source === 'github-assets' ? { executable: true } : { extract: { format: 'none' as const } }),
          },
        ],
      },
    ],
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
  ])
    expect(() => withSuiteCatalogContentHash(runtime(hostile)), hostile).toThrow()
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
  const suite = withSuiteCatalogContentHash({
    kind: 'suite',
    id: 'plain-suite',
    version: '1.0.0',
    engines: { platform: '>=0.1.18' },
    adapters: [],
    title: { en: 'Suite', 'zh-CN': '套件' },
    description: { en: 'Suite', 'zh-CN': '套件' },
    source: { en: 'fixture', 'zh-CN': '夹具' },
    identity: { en: 'Identity', 'zh-CN': '身份' },
    dependencies: [],
    items: [],
  } as UnsealedSuiteCatalogDocumentEntry)
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
    kind: 'dependency',
    id: 'registry-spec',
    version: '1.0.0',
    engines: { platform: '>=0.1.18' },
    adapters: [],
    title: { en: 'Tool', 'zh-CN': '工具' },
    description: { en: 'Tool', 'zh-CN': '工具' },
    source: { en: 'fixture', 'zh-CN': '夹具' },
    items: [{ kind: 'runtime-dependency', name: 'tool', paths: ['bin'], commands: ['tool'], downloads: [{ source, packages }] }],
  })
  expect(() => withSuiteCatalogContentHash(registry(['tool@1.2.3']))).not.toThrow()
  expect(() => withSuiteCatalogContentHash(registry(['@scope/tool@1.2.3']))).not.toThrow()
  // Structural rejection of shell-active or range syntax; the runtime check rejects unpinned packages later.
  for (const spec of ['tool@^1.2.3', 'tool@~1.2.3', 'tool@*', 'tool@>=1.2.3', 'tool@1.2.3 $(id)', 'tool;id'])
    expect(() => withSuiteCatalogContentHash(registry([spec])), spec).toThrow()
  expect(() => withSuiteCatalogContentHash(registry(['tool==1.0.0'], 'pypi'))).not.toThrow()
  expect(() => withSuiteCatalogContentHash(registry(['tool>=1.0.0'], 'pypi'))).toThrow()
})

it('rejects a document that names the same entry id twice', () => {
  const entry = onlineCatalogEntries[0]!
  const document = { format: 1, publishedAt: '2026-10-18T00:00:00.000Z', entries: [entry, entry], signature: { keyId: 'k', signature: 's' } }
  expect(readSuiteCatalogDocument(Buffer.from(JSON.stringify(document)))).toMatchObject({
    okay: false,
    rejection: 'invalid-structure',
    detail: 'entries: duplicate id',
  })
})

it('rejects unnormalized path declarations so wrappers can resolve the preparation root', () => {
  const key = createCatalogSigningKey()
  const entry = (path: string): UnsealedSuiteCatalogDocumentEntry =>
    ({
      kind: 'dependency',
      id: 'path-fixture',
      version: '1.0.0',
      engines: { platform: '>=0.1.18' },
      adapters: [],
      title: { en: 'Path fixture', 'zh-CN': '路径夹具' },
      description: { en: 'Fixture', 'zh-CN': '夹具' },
      source: { en: 'fixture', 'zh-CN': '夹具' },
      items: [{ kind: 'runtime-dependency', name: 'tools', paths: [path], commands: ['tool'], downloads: [{ source: 'npm', packages: ['tool@1.0.0'] }] }],
    }) as UnsealedSuiteCatalogDocumentEntry
  for (const path of ['bin/', '.', './bin', 'bin/../lib', '/bin', 'bin//nested', 'bin/.']) {
    // Path declarations are normalized while the content hash is computed, so invalid paths cannot even be sealed.
    expect(() => withSuiteCatalogContentHash(entry(path)), path).toThrow('runtime-dependency.paths')
  }
  expect(readSuiteCatalogDocument(signCatalog([withSuiteCatalogContentHash(entry('tools/bin'))], key).bytes)).toMatchObject({ okay: true })
})

it('reads a signed Python library with a locked wheel-only venv and explicit architecture support', () => {
  const library = withSuiteCatalogContentHash({
    kind: 'dependency',
    id: 'python-documents',
    version: '1.0.0',
    engines: { platform: '>=0.1.24' },
    adapters: [],
    title: { en: 'Python documents', 'zh-CN': 'Python 文档库' },
    description: { en: 'Libraries', 'zh-CN': '库' },
    source: { en: 'PyPI', 'zh-CN': 'PyPI' },
    items: [
      {
        kind: 'runtime-dependency',
        name: 'python-documents',
        type: 'python-library',
        architectures: ['amd64'],
        paths: ['venv/bin'],
        commands: ['python3'],
        downloads: [{ source: 'pypi', packages: ['PyMuPDF==2.0', 'six==1.17.0'] }],
      },
    ],
  })
  const key = createCatalogSigningKey(),
    bytes = signCatalog([onlineCatalogEntries[0]!, library], key).bytes
  const read = readSuiteCatalog(bytes, { trustedKeys: [key], platformVersion: '0.1.24' })
  expect(read.status).toBe('ok')
  if (read.status !== 'ok') return
  expect(read.rejected).toEqual([])
  const item = read.entries.find(row => row.entry.id === library.id)!.entry.items[0]!
  if (item.kind !== 'runtime-dependency') throw new Error('expected dependency')
  expect(item.prepareCommands.arm64).toBeUndefined()
  const definition = suiteRuntimeDependencyDefinition(item, 'amd64')
  expect(definition).toMatchObject({ type: 'python-library', packages: ['pymupdf==2.0', 'six==1.17.0'] })
  expect(definition!.prepareCommand).toContain('--copies')
  expect(definition!.prepareCommand).toContain('--only-binary=:all: --no-deps')
  const older = readSuiteCatalog(bytes, { trustedKeys: [key], platformVersion: '0.1.23' })
  expect(older).toMatchObject({ status: 'ok', rejected: [{ id: library.id, reason: 'needs-platform-upgrade' }] })
})

it('reads a bounded set of individually pinned resource files without fetching an entire source archive', () => {
  const resource = (count: number): UnsealedSuiteCatalogDocumentEntry => ({
    kind: 'dependency',
    id: 'static-resources',
    version: '1.0.0',
    engines: { platform: '>=0.1.24' },
    adapters: [],
    title: { en: 'Static resources', 'zh-CN': '静态资源' },
    description: { en: 'Pinned files', 'zh-CN': '锁定文件' },
    source: { en: 'GitHub', 'zh-CN': 'GitHub' },
    items: [
      {
        kind: 'runtime-dependency',
        name: 'static-resources',
        type: 'resource',
        paths: [],
        commands: [],
        downloads: Array.from({ length: count }, (_, index) => ({
          source: 'github-assets',
          url: `https://github.com/example/static-resources/raw/${'a'.repeat(40)}/assets/file-${index}@2x.js`,
          target: `assets/file-${index}@2x.js`,
          sha256: { amd64: index.toString(16).padStart(64, '0'), arm64: index.toString(16).padStart(64, '0') },
        })),
      },
    ],
  })
  const entry = withSuiteCatalogContentHash(resource(256)),
    key = createCatalogSigningKey()
  const result = readSuiteCatalog(signCatalog([entry], key).bytes, { trustedKeys: [key], platformVersion: '0.1.24' })
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(result.rejected).toEqual([])
  const item = result.entries[0]!.entry.items[0]!
  if (item.kind !== 'runtime-dependency') throw new Error('Expected resource dependency')
  const definition = suiteRuntimeDependencyDefinition(item, 'amd64')!
  expect(definition.type).toBe('resource')
  expect(definition.prepareCommand.match(/curl --fail/gu)).toHaveLength(256)
  expect(definition.prepareCommand).toContain(
    '${GITHUB_ASSETS_PREFIX}https://github.com/example/static-resources/raw/' + 'a'.repeat(40) + '/assets/file-255@2x.js',
  )
  expect(definition.prepareCommand).toContain('00000000000000000000000000000000000000000000000000000000000000ff  assets/file-255@2x.js')
  expect(Buffer.byteLength(definition.prepareCommand)).toBeLessThanOrEqual(128 * 1024)
  for (const count of [0, 257]) expect(() => withSuiteCatalogContentHash(resource(count))).toThrow('runtime-dependency.downloads')
})

it('accepts safe delegated script aliases and optional backend variables while refusing source traversal', () => {
  const base = onlineCatalogEntries.find(row => row.id === 'minimax' && row.kind === 'suite')!
  if (base.kind !== 'suite') throw new Error('Missing suite fixture')
  const entry = {
    ...base,
    items: base.items.map(item =>
      item.kind === 'execution'
        ? {
            ...item,
            delegated: [
              { command: 'cloud-audio', source: 'scripts/audio.py', memberPath: 'scripts/cloud_audio.py', blockedOptions: ['--base-url'], blocked: [] },
            ],
            variables: item.variables.map(row => ({ ...row, optional: true })),
          }
        : item,
    ),
  }
  const sealed = withSuiteCatalogContentHash(entry)
  const key = createCatalogSigningKey()
  const read = readSuiteCatalog(signCatalog([sealed], key).bytes, { trustedKeys: [key], platformVersion: '0.1.24' })
  expect(sealed.kind === 'suite' && sealed.items.find(item => item.kind === 'execution')).toMatchObject({
    delegated: [{ command: 'cloud-audio', source: 'scripts/audio.py', memberPath: 'scripts/cloud_audio.py' }],
    variables: [{ optional: true }],
  })
  expect(read).toMatchObject({
    status: 'ok',
    rejected: [],
    entries: [
      {
        entry: {
          items: expect.arrayContaining([
            expect.objectContaining({
              kind: 'execution',
              delegated: [
                { command: 'cloud-audio', source: 'scripts/audio.py', memberPath: 'scripts/cloud_audio.py', blockedOptions: ['--base-url'], blocked: [] },
              ],
              variables: [expect.objectContaining({ optional: true })],
            }),
          ]),
        },
      },
    ],
  })
  expect(() =>
    withSuiteCatalogContentHash({
      ...entry,
      items: entry.items.map(item =>
        item.kind === 'execution' ? { ...item, delegated: [{ command: 'scripts/cloud_audio.py', source: '../audio.py', blocked: [] }] } : item,
      ),
    }),
  ).toThrow('execution.delegated.source')
})
