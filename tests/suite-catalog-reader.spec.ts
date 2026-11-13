import { suiteCatalogViolations } from '../src/domain/suite-catalog-checks.js'
import { expect, it } from 'vitest'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { suiteRuntimeDependencyDefinition, type SuiteCatalogRuntimeDependencyItem } from '../src/domain/suite-catalog.js'
import { suiteCatalogContentHash, withSuiteCatalogContentHash, type UnsealedSuiteCatalogDocumentEntry } from '../src/domain/suite-catalog-document.js'
import { officialSuiteCatalogKeys } from '../src/domain/suite-catalog-keys.js'
import { createCatalogSigningKey, signCatalog, signRawCatalog, type CatalogSigningKey } from './fixtures/suite-catalog-signing.js'
import { legacyPrepareCommands, onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

const key = createCatalogSigningKey()
const options = { trustedKeys: [key], platformVersion: '0.1.19' }
const minimal = (overrides: Partial<UnsealedSuiteCatalogDocumentEntry> = {}): UnsealedSuiteCatalogDocumentEntry =>
  ({
    kind: 'dependency',
    id: 'fixture-tool',
    version: '1.0.0',
    engines: { platform: '>=0.1.18' },
    adapters: [],
    title: { en: 'Fixture tool', 'zh-CN': '夹具工具' },
    description: { en: 'Fixture', 'zh-CN': '夹具' },
    source: { en: 'fixture', 'zh-CN': '夹具' },
    items: [
      {
        kind: 'runtime-dependency',
        name: 'fixture-tool',
        paths: ['bin'],
        commands: ['fixture-tool'],
        downloads: [{ source: 'npm', packages: ['fixture-tool@1.0.0'] }],
      },
    ],
    ...overrides,
  }) as UnsealedSuiteCatalogDocumentEntry

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
      const expected =
        id === 'pandoc' ? `set -eu\n${legacyPrepareCommands.pandoc![architecture].split(' && ').join('\n')}` : legacyPrepareCommands[id]![architecture]
      expect(suiteRuntimeDependencyDefinition(item, architecture)?.prepareCommand).toBe(expected)
    }
  }
  expect(result.rejected).toEqual([])
  expect(result.skipped).toEqual([])
})

it('rejects the whole catalog for unreadable bytes, an unknown format, an unknown key and a bad signature', () => {
  expect(readSuiteCatalog(Buffer.from('not json'), options)).toMatchObject({ status: 'rejected', reason: 'invalid-document' })
  expect(
    readSuiteCatalog(
      Buffer.from(JSON.stringify({ format: 99, publishedAt: '2026-10-18T00:00:00Z', entries: [], signature: { keyId: 'k', signature: 's' } })),
      options,
    ),
  ).toMatchObject({ status: 'rejected', reason: 'unsupported-format' })
  const fixture = signCatalog(onlineCatalogEntries, key)
  expect(readSuiteCatalog(fixture.bytes, { ...options, trustedKeys: [createCatalogSigningKey('other-key')] })).toMatchObject({
    status: 'rejected',
    reason: 'unknown-key',
  })
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
  if (result.status === 'ok')
    expect(result.entries).toMatchObject([{ entry: { id: 'pandoc', unavailableReason: 'content-hash-mismatch' }, unavailableReason: 'content-hash-mismatch' }])
})

it('marks entries that need a newer platform and entries that reference unknown adapters, without rejecting the rest', () => {
  const newer = withSuiteCatalogContentHash(minimal({ id: 'newer', engines: { platform: '>=999.0.0' } }))
  const adapter = withSuiteCatalogContentHash(minimal({ id: 'adapter', adapters: [{ name: 'secret-adapter', params: {} }] }))
  const compatible = onlineCatalogEntries.find(row => row.id === 'pandoc')!
  const result = readSuiteCatalog(signCatalog([compatible, newer, adapter], key).bytes, options)
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(result.entries.map(row => [row.entry.id, row.entry.unavailableReason])).toEqual([
    ['pandoc', undefined],
    ['newer', 'needs-platform-upgrade'],
    ['adapter', 'unknown-adapter'],
  ])
  expect(result.rejected).toEqual([
    { id: 'newer', version: '1.0.0', reason: 'needs-platform-upgrade', detail: '>=999.0.0' },
    { id: 'adapter', version: '1.0.0', reason: 'unknown-adapter', detail: 'adapters[0]: secret-adapter' },
  ])
})

it('skips reserved entry kinds before compatibility rules and records them in the log result', () => {
  // Even an adapter this platform does not know and an unreachable platform range are skipped, not rejected.
  const plugin = withSuiteCatalogContentHash({
    kind: 'mcp',
    id: 'reserved-plugin',
    version: '1.0.0',
    engines: { platform: '>=999.0.0' },
    adapters: [{ name: 'unknown-adapter', params: {} }],
    title: { en: 'Plugin', 'zh-CN': '插件' },
    description: { en: 'Plugin', 'zh-CN': '插件' },
    source: { en: 'fixture', 'zh-CN': '夹具' },
  } as UnsealedSuiteCatalogDocumentEntry)
  const result = readSuiteCatalog(signCatalog([plugin, ...onlineCatalogEntries], key).bytes, options)
  expect(result).toMatchObject({ status: 'ok', skipped: [{ id: 'reserved-plugin', kind: 'mcp' }], rejected: [] })
  if (result.status === 'ok')
    expect(result.entries.map(row => row.entry.id)).toEqual(['pandoc', 'ffmpeg', 'chromium', 'wecom', 'officecli', 'minimax', 'lark', 'hyperframes'])
})

it('ships the official key and refuses catalogs signed by a test fixture', () => {
  expect(officialSuiteCatalogKeys).toHaveLength(1)
  expect(officialSuiteCatalogKeys[0]!.keyId).toMatch(/^official-[a-f0-9]{16}$/u)
  expect(officialSuiteCatalogKeys.some(row => row.keyId === key.keyId)).toBe(false)
  const fixture = signCatalog(onlineCatalogEntries, key)
  expect(readSuiteCatalog(fixture.bytes, { platformVersion: '0.1.19', trustedKeys: officialSuiteCatalogKeys })).toMatchObject({
    status: 'rejected',
    reason: 'unknown-key',
  })
})

it('exposes the documented read options shape for keys and platform version', () => {
  const trusted: CatalogSigningKey = key
  expect(options.trustedKeys[0]).toMatchObject({ keyId: trusted.keyId })
  expect(typeof options.platformVersion).toBe('string')
})

it('passes declared runtime service addresses through to the platform entry', () => {
  const entry = withSuiteCatalogContentHash({
    ...(onlineCatalogEntries.find(row => row.id === 'wecom') as never as Record<string, unknown>),
    serviceAddresses: ['https://qyapi.weixin.qq.com'],
  } as never)
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
  expect(readSuiteCatalog(signCatalog([smuggled], signingKey).bytes, { trustedKeys: [signingKey], platformVersion: '0.1.19' })).toMatchObject({
    status: 'ok',
    rejected: [{ id: 'pandoc', reason: 'content-hash-mismatch' }],
  })

  // Tampering with a signed top-level field breaks the signature.
  const document = JSON.parse(signCatalog([sealedWithUnknown], signingKey).bytes.toString('utf8')) as Record<string, unknown>
  document.publishedAt = '2030-01-01T00:00:00.000Z'
  expect(readSuiteCatalog(Buffer.from(JSON.stringify(document)), { trustedKeys: [signingKey], platformVersion: '0.1.19' })).toMatchObject({
    status: 'rejected',
    reason: 'invalid-signature',
  })
})

it('accepts a handwritten document signed as written, including a suite without optional service addresses', () => {
  const signingKey = createCatalogSigningKey()
  const rawEntry: Record<string, unknown> = {
    kind: 'suite',
    id: 'handmade',
    version: '2.0.0',
    engines: { platform: '>=0.1.18' },
    adapters: [],
    title: { en: 'Handmade', 'zh-CN': '手写' },
    description: { en: 'Handmade', 'zh-CN': '手写' },
    source: { en: 'fixture', 'zh-CN': '夹具' },
    identity: { en: 'Identity', 'zh-CN': '身份' },
    dependencies: [],
    items: [],
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
  const unpinned = withSuiteCatalogContentHash(
    minimal({
      items: [
        {
          kind: 'runtime-dependency',
          name: 'fixture-tool',
          paths: ['node_modules/.bin'],
          commands: ['fixture-tool'],
          downloads: [{ source: 'npm', packages: ['fixture-tool'] }],
        },
      ],
    }),
  )
  const result = readSuiteCatalog(signCatalog([unpinned], signingKey).bytes, { trustedKeys: [signingKey], platformVersion: '0.1.19' })
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(result.entries[0]!.entry).toMatchObject({ unavailableReason: 'invalid-entry' })
  expect(result.entries[0]!.unavailableDetail).toContain('must pin an exact version')
  expect(result.rejected).toEqual([
    { id: 'fixture-tool', version: '1.0.0', reason: 'invalid-entry', detail: expect.stringContaining('must pin an exact version') },
  ])
})

it('rejects a single entry with invalid adapter parameters without rejecting the document', () => {
  const invalid = withSuiteCatalogContentHash(
    minimal({ id: 'bad-adapter', adapters: [{ name: 'fixed-environment', params: { item: 'missing', command: 'tool', environment: { A: '1' } } }] }),
  )
  const compatible = onlineCatalogEntries.find(row => row.id === 'pandoc')!
  const result = readSuiteCatalog(signCatalog([compatible, invalid], key).bytes, options)
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(result.entries.map(row => [row.entry.id, row.entry.unavailableReason])).toEqual([
    ['pandoc', undefined],
    ['bad-adapter', 'invalid-adapter-params'],
  ])
  expect(result.rejected).toEqual([
    { id: 'bad-adapter', version: '1.0.0', reason: 'invalid-adapter-params', detail: 'fixed-environment needs an existing item and command' },
  ])
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
  for (const adapters of [
    [{ name: 'only-a-name' }],
    [{ params: {} }],
    [{ name: 'bad name', params: {} }],
    'not-a-list',
    [{ name: 'fixed-environment', params: [] }],
  ]) {
    const raw = signRawCatalog({ format: 1, publishedAt: '2026-10-18T00:00:00.000Z', entries: [{ ...good, adapters }] }, key)
    expect(readSuiteCatalog(raw, options), JSON.stringify(adapters)).toMatchObject({ status: 'rejected', reason: 'invalid-document' })
  }
  // A well-shaped call with an unknown adapter name is still a single-entry rejection.
  const unknown = withSuiteCatalogContentHash(minimal({ id: 'unknown-shape', adapters: [{ name: 'unknown-adapter', params: {} }] }))
  const read = readSuiteCatalog(signCatalog([unknown], key).bytes, options)
  if (read.status !== 'ok') throw new Error('fixture catalog was rejected')
  expect(read.rejected[0]).toMatchObject({ id: 'unknown-shape', reason: 'unknown-adapter' })
})

it('reads and converts a signed pure-resource dependency without inventing PATH commands', () => {
  const resource = {
    kind: 'runtime-dependency' as const,
    type: 'resource' as const,
    name: 'office-sdk',
    paths: [],
    commands: [],
    downloads: [
      {
        source: 'github-assets' as const,
        url: 'https://github.com/fixture/sdk/archive/' + 'a'.repeat(40) + '.tar.gz',
        sha256: { amd64: 'a'.repeat(64), arm64: 'a'.repeat(64) },
        target: 'sdk.tar.gz',
        extract: { format: 'tar' as const },
      },
    ],
  }
  const entry = withSuiteCatalogContentHash(minimal({ id: 'office-sdk', engines: { platform: '>=0.1.24' }, items: [resource] }))
  const result = readSuiteCatalog(signCatalog([entry], key).bytes, { ...options, platformVersion: '0.1.24' })
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(result.rejected).toEqual([])
  const item = result.entries[0]!.entry.items[0] as SuiteCatalogRuntimeDependencyItem
  expect(item).toMatchObject({ type: 'resource', pathDirectories: [], commands: [] })
  expect(suiteRuntimeDependencyDefinition(item, 'arm64')).toMatchObject({
    type: 'resource',
    pathDirectories: [],
    prepareCommand: expect.stringContaining('sdk.tar.gz'),
  })
  const { type, ...ordinary } = resource
  void type
  expect(() => withSuiteCatalogContentHash(minimal({ items: [ordinary] }))).toThrow()
})

it('reads signed plugin entries with locked npm identity, embedded resources and access templates', () => {
  const plugin = withSuiteCatalogContentHash({
    ...minimal(),
    kind: 'plugin',
    id: 'fixture-plugin',
    dependencies: [],
    items: [
      {
        kind: 'plugin',
        packageName: '@fixture/editor',
        version: '1.2.3',
        integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
        runtimeDependencies: [],
        catalogDependencies: [],
        access: { environment: [{ name: 'EDITOR_MODE', value: 'shared' }], entriesYaml: '' },
      },
    ],
  } as never)
  expect(readSuiteCatalog(signCatalog([plugin], key).bytes, { ...options, platformVersion: '0.1.24' })).toMatchObject({
    status: 'ok',
    skipped: [],
    rejected: [],
    entries: [{ entry: { category: 'plugin', items: [{ kind: 'plugin', packageName: '@fixture/editor', version: '1.2.3' }] } }],
  })
})

it('keeps old entries available when a signed catalog adds a version-gated plugin archive', () => {
  const archive = { url: 'https://github.com/fixture/editor/releases/download/v1.2.3/editor.tgz' }
  const item = {
    kind: 'plugin' as const,
    packageName: '@fixture/editor',
    version: '1.2.3',
    integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
    runtimeDependencies: [],
    catalogDependencies: [],
    access: { environment: [], entriesYaml: '' },
  }
  const definition = {
    ...minimal(),
    kind: 'plugin' as const,
    id: 'fixture-npm',
    dependencies: [],
    identity: { en: 'Editor', 'zh-CN': '编辑器' },
    items: [item],
  }
  const npm = withSuiteCatalogContentHash(definition)
  const archived = withSuiteCatalogContentHash({
    ...definition,
    id: 'fixture-archive',
    engines: { platform: '>=0.1.35' },
    items: [{ ...item, archive }],
  })
  const bytes = signCatalog([npm, archived], key).bytes
  expect(readSuiteCatalog(bytes, { ...options, platformVersion: '0.1.34' })).toMatchObject({
    status: 'ok',
    rejected: [{ id: 'fixture-archive', reason: 'needs-platform-upgrade' }],
    entries: [{ entry: { id: 'fixture-npm' } }, { entry: { id: 'fixture-archive' } }],
  })
  expect(readSuiteCatalog(bytes, { ...options, platformVersion: '0.1.35' })).toMatchObject({
    status: 'ok',
    rejected: [],
    entries: [{ entry: { id: 'fixture-npm' } }, { entry: { items: [{ archive }] } }],
  })
})

it.each([
  [{ url: 'https://github.com/fixture/editor/releases/download/v1.2.3/editor.tgz' }, '>=0.1.35 || 0.1.34'],
  [{ url: 'https://github.com/fixture/editor/archive/main.tar.gz' }, '>=0.1.35'],
  [{ url: 'https://example.com/fixture/editor/releases/download/v1.2.3/editor.tgz' }, '>=0.1.35'],
  [{ url: 'https://github.com/fixture/editor/releases/download/v1.2.3/editor.tgz', script: 'echo unexpected' }, '>=0.1.35'],
])('refuses an unsafe archive declaration without hiding unrelated signed entries (%j, %s)', (archive, platform) => {
  const plugin = {
    ...minimal(),
    kind: 'plugin',
    id: 'fixture-archive',
    engines: { platform },
    dependencies: [],
    items: [
      {
        kind: 'plugin',
        packageName: '@fixture/editor',
        version: '1.2.3',
        integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
        runtimeDependencies: [],
        catalogDependencies: [],
        access: { environment: [], entriesYaml: '' },
        archive,
      },
    ],
  }
  const bytes = signRawCatalog(
    {
      format: 1,
      publishedAt: '2026-11-11T00:00:00Z',
      entries: [withSuiteCatalogContentHash(minimal()), { ...plugin, contentHash: suiteCatalogContentHash(plugin) }],
    },
    key,
  )
  expect(readSuiteCatalog(bytes, { ...options, platformVersion: '0.1.35' })).toMatchObject({
    status: 'ok',
    rejected: [{ id: 'fixture-archive', reason: 'invalid-entry' }],
    entries: [{ entry: { id: 'fixture-tool' } }, { entry: { id: 'fixture-archive' } }],
  })
})

it('verifies resource readiness markers for the selected architecture without executing catalog code', () => {
  const makeEntry = (requiredFiles: unknown, platform = '>=0.1.35') => {
    const entry = {
      ...minimal({ engines: { platform } }),
      items: [
        {
          kind: 'runtime-dependency',
          type: 'resource',
          name: 'fixture-resource',
          paths: [],
          commands: [],
          downloads: [
            {
              source: 'github-assets',
              url: { arm64: 'https://github.com/fixture/sdk/releases/download/v1.0.0/sdk.tar.gz' },
              sha256: { arm64: 'a'.repeat(64) },
              target: 'sdk.tar.gz',
              extract: { format: 'tar' },
            },
          ],
          requiredFiles,
        },
      ],
    }
    return { ...entry, contentHash: suiteCatalogContentHash(entry) }
  }
  const digest = 'b'.repeat(64)
  const marker = { path: '.ready.json', sha256: { arm64: digest } }
  const read = (files: unknown, version = '0.1.35', platform = '>=0.1.35') =>
    readSuiteCatalog(signRawCatalog({ format: 1, publishedAt: '2026-11-11T00:00:00Z', entries: [makeEntry(files, platform)] }, key), {
      ...options,
      platformVersion: version,
    })
  expect(read([marker], '0.1.34')).toMatchObject({ status: 'ok', rejected: [{ reason: 'needs-platform-upgrade' }] })
  const valid = read([marker])
  expect(valid).toMatchObject({ status: 'ok', rejected: [] })
  if (valid.status !== 'ok') throw new Error('Expected a readable catalog')
  const item = valid.entries[0]!.entry.items[0] as SuiteCatalogRuntimeDependencyItem
  expect(suiteRuntimeDependencyDefinition(item, 'arm64')?.checkCommand).toContain(digest)
  expect(suiteRuntimeDependencyDefinition(item, 'arm64')?.checkCommand).toContain('./.ready.json')
  expect(suiteRuntimeDependencyDefinition(item, 'amd64')).toBeUndefined()
  for (const files of [
    [{ ...marker, path: '../.ready.json' }],
    [{ ...marker, path: '.ready.json\n' }],
    [{ ...marker, sha256: { amd64: digest } }],
    [{ ...marker, script: 'id' }],
    [marker, marker],
  ])
    expect(read(files)).toMatchObject({ status: 'ok', rejected: [{ reason: 'invalid-entry' }] })
  expect(read([marker], '0.1.35', '>=0.1.34')).toMatchObject({ status: 'ok', rejected: [{ reason: 'invalid-entry' }] })
})

it('reads typed backend fields scoped to declared execution commands and variables', () => {
  const label = { en: 'Fixture', 'zh-CN': '夹具' }
  const slots = [
    {
      id: 'image',
      label,
      commands: ['fixture-image'],
      backends: [
        {
          id: 'openai',
          label,
          selector: { kind: 'environment', name: 'IMAGE_BACKEND', value: 'openai' },
          fields: [
            { name: 'OPENAI_KEY', type: 'secret', required: true },
            { name: 'OPENAI_URL', type: 'url', required: false },
          ],
        },
      ],
    },
  ]
  const read = (
    serviceSlots: unknown,
    platform = '>=0.1.35',
    variables = ['IMAGE_BACKEND', 'OPENAI_KEY', 'OPENAI_URL'],
    protection?: { at: 'command' | 'item'; options: unknown; values?: unknown },
  ) => {
    const base = minimal()
    const entry = {
      ...base,
      kind: 'suite',
      identity: label,
      dependencies: [],
      engines: { platform },
      items: [
        ...('items' in base ? base.items : []),
        { kind: 'skill', source: { type: 'git', url: 'https://github.com/fixture/skill', commit: 'a'.repeat(40), path: 'skills' }, names: ['fixture-skill'] },
        {
          kind: 'execution',
          skill: 'fixture-skill',
          runtimeDependency: 'fixture-tool',
          delegated: [
            {
              command: 'fixture-image',
              blocked: [],
              ...(protection?.at === 'command'
                ? { blockedShortOptions: protection.options, ...(protection.values !== undefined ? { shortOptionsWithValue: protection.values } : {}) }
                : {}),
            },
          ],
          ...(protection?.at === 'item' ? { blockedShortOptions: protection.options } : {}),
          variables: variables.map(name => ({ name, optional: true, purpose: label })),
          serviceSlots,
        },
      ],
    }
    return readSuiteCatalog(
      signRawCatalog(
        {
          format: 1,
          publishedAt: '2026-11-11T00:00:00Z',
          entries: [{ ...entry, contentHash: suiteCatalogContentHash(entry) }],
        },
        key,
      ),
      { ...options, platformVersion: '0.1.35' },
    )
  }
  expect(read(slots)).toMatchObject({
    status: 'ok',
    rejected: [],
    entries: [{ entry: { items: expect.arrayContaining([expect.objectContaining({ kind: 'execution', serviceSlots: slots })]) } }],
  })
  expect(read(slots, '>=0.1.35', ['IMAGE_BACKEND', 'OPENAI_KEY', 'OPENAI_URL', 'NODE_OPTIONS'])).toMatchObject({
    status: 'ok',
    rejected: [{ reason: 'invalid-entry' }],
  })
  expect(read(slots, '>=0.1.34')).toMatchObject({ status: 'ok', rejected: [{ reason: 'invalid-entry' }] })

  expect(read(slots, '>=0.1.35', undefined, { at: 'command', options: ['-b'], values: ['-o'] })).toMatchObject({
    status: 'ok',
    rejected: [],
    entries: [
      {
        entry: {
          items: expect.arrayContaining([
            expect.objectContaining({ delegated: [{ command: 'fixture-image', blocked: [], blockedOptions: ['-b'], shortOptionsWithValue: ['-o'] }] }),
          ]),
        },
      },
    ],
  })
  for (const [floor, protection] of [
    ['>=0.1.34', { at: 'command', options: ['-b'] }],
    ['>=0.1.35', { at: 'item', options: ['-b'] }],
    ['>=0.1.35', { at: 'command', options: ['--backend'] }],
    ['>=0.1.35', { at: 'command', options: ['-b'], values: ['-b'] }],
  ] as const) {
    expect(read(slots, floor, undefined, protection)).toMatchObject({ status: 'ok', rejected: [{ reason: 'invalid-entry' }] })
  }
  const [slot] = slots
  const backend = slot!.backends[0]!
  const firstProvider = { ...backend, selector: { kind: 'option', name: '--provider', value: 'first' } }
  const secondProvider = { ...backend, id: 'second', selector: { kind: 'option', name: '--provider', value: 'second' } }
  expect(read([{ ...slot, backends: [firstProvider, secondProvider] }])).toMatchObject({ status: 'ok', rejected: [] })
  for (const invalid of [
    [{ ...slot, backends: [firstProvider, { ...secondProvider, selector: firstProvider.selector }] }],
    [{ ...slot, backends: [backend, { ...backend, id: 'second', selector: undefined }] }],
    [{ ...slot, backends: [{ ...backend, fields: [{ name: 'OPENAI_URL', type: 'url', required: false }] }] }],
    [{ ...slot, commands: ['unknown'] }],
    [{ ...slot, backends: [{ ...backend, selector: { kind: 'environment', name: 'UNDECLARED', value: 'openai' } }] }],
    [{ ...slot, backends: [{ ...backend, fields: [{ name: 'OPENAI_KEY', type: 'shell', required: true }] }] }],
    [{ ...slot, backends: [{ ...backend, fields: [{ name: 'UNDECLARED', type: 'secret', required: true }] }] }],
    [{ ...slot, backends: [{ ...backend, script: 'id' }] }],
    [slot, { ...slot, id: 'other' }],
  ])
    expect(read(invalid)).toMatchObject({ status: 'ok', rejected: [{ reason: 'invalid-entry' }] })
})

it('validates native plugin service bindings for the signed package version', () => {
  const label = { en: 'Fixture', 'zh-CN': '夹具' }
  const binding = {
    kind: 'revisioned-rpc',
    service: 'fixtureSettings',
    active: ['settings', 'ai'],
    selection: ['settings', 'ai', 'selected'],
    profiles: ['settings', 'ai', 'profiles'],
    idKey: 'id',
    snapshotKey: 'snapshot',
    fields: { endpoint: 'baseUrl', key: 'apiKey', model: 'model', mode: 'engine', enabled: 'enabled' },
  }
  const backend = {
    id: 'standard',
    label,
    protocol: 'openai-image',
    mode: 'api',
    profile: { alias: 'Platform' },
    upstream: { endpoint: 'URL', key: 'KEY', model: 'MODEL' },
    fields: [
      { name: 'URL', type: 'url', required: true },
      { name: 'KEY', type: 'secret', required: true },
      { name: 'MODEL', type: 'text', required: true },
    ],
  }
  const slot = { id: 'image', label, binding, backends: [backend] }
  const read = (serviceSlots: unknown, platformVersion = '0.1.35') => {
    const entry = {
      ...minimal({ engines: { platform: '>=0.1.35' } }),
      kind: 'plugin',
      dependencies: [],
      items: [
        {
          kind: 'plugin',
          packageName: 'fixture-editor',
          version: '1.2.3',
          integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
          runtimeDependencies: [],
          catalogDependencies: [],
          access: { environment: [], entriesYaml: '' },
          serviceSlots,
        },
      ],
    }
    return readSuiteCatalog(
      signRawCatalog(
        {
          format: 1,
          publishedAt: '2026-11-11T00:00:00Z',
          entries: [{ ...entry, contentHash: suiteCatalogContentHash(entry) }],
        },
        key,
      ),
      { ...options, platformVersion },
    )
  }
  expect(read([slot])).toMatchObject({
    status: 'ok',
    rejected: [],
    entries: [{ entry: { items: [{ version: '1.2.3', serviceSlots: [slot] }] } }],
  })
  expect(read([slot], '0.1.34')).toMatchObject({ status: 'ok', rejected: [{ reason: 'needs-platform-upgrade' }] })
  for (const invalid of [
    [{ ...slot, binding: { ...binding, selection: ['settings', '..', 'selected'] } }],
    [{ ...slot, binding: { ...binding, profiles: ['settings', '__proto__'] } }],
    [{ ...slot, binding: { ...binding, service: 'untrusted/request' } }],
    [{ ...slot, binding: { ...binding, save: 'request' } }],
    [{ ...slot, binding: { ...binding, fields: { ...binding.fields, endpoint: 'apiKey' } } }],
    [{ ...slot, backends: [{ ...backend, protocol: 'custom-script' }] }],
    [{ ...slot, backends: [{ ...backend, upstream: { ...backend.upstream, key: 'URL' } }] }],
    [{ ...slot, backends: [{ ...backend, profile: { apiKey: 'disallowed' } }] }],
    [{ ...slot, backends: [{ ...backend, profile: { alias: { script: 'id' } } }] }],
    [slot, { ...slot, id: 'another' }],
  ])
    expect(read(invalid)).toMatchObject({ status: 'ok', rejected: [{ reason: 'invalid-entry' }] })
})

it('checks and renders bindings to exact locked resources at publication', () => {
  const base = minimal({ engines: { platform: '>=0.1.35' } })
  const dependency = {
    ...base,
    kind: 'dependency',
    id: 'shared-assets',
    locked: true,
    items: [
      {
        kind: 'runtime-dependency',
        type: 'resource',
        name: 'shared-assets',
        paths: [],
        commands: [],
        downloads: [
          {
            source: 'github-assets',
            url: { arm64: 'https://github.com/fixture/assets/releases/download/v1.0.0/assets.tgz' },
            sha256: { arm64: 'a'.repeat(64) },
            target: 'assets.tgz',
            extract: { format: 'tar' },
          },
        ],
        requiredFiles: [
          { path: 'assets/marker.json', sha256: { arm64: 'a'.repeat(64) } },
          { path: 'native/cache/metadata/marker.json', sha256: { arm64: 'b'.repeat(64) } },
          { path: 'native/cache/store/marker.json', sha256: { arm64: 'c'.repeat(64) } },
        ],
      },
    ],
  }
  const resource = { ...dependency, contentHash: suiteCatalogContentHash(dependency) }
  const pin = { dependency: dependency.id, version: resource.version, contentHash: resource.contentHash, name: 'ASSET_ROOT', path: 'assets' }
  const read = (bindings: readonly object[], shared: object = resource, embedded: readonly string[] = []) => {
    const plugin = {
      ...base,
      kind: 'plugin',
      id: 'fixture-plugin',
      dependencies: [dependency.id],
      items: [
        {
          kind: 'plugin',
          packageName: 'fixture-editor',
          version: '1.2.3',
          integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
          runtimeDependencies: embedded,
          catalogDependencies: [dependency.id],
          access: { environment: [], entriesYaml: '' },
          resourceBindings: bindings,
        },
      ],
    }
    return readSuiteCatalog(
      signRawCatalog(
        {
          format: 1,
          publishedAt: '2026-11-11T00:00:00Z',
          entries: [shared, { ...plugin, contentHash: suiteCatalogContentHash(plugin) }],
        },
        key,
      ),
      { ...options, platformVersion: '0.1.35' },
    )
  }
  const cache = {
    kind: 'native-package-cache',
    dependency: pin.dependency,
    version: pin.version,
    contentHash: pin.contentHash,
    path: 'native/cache',
    packages: [{ packageName: 'fixture-export', version: '2.1.0' }],
  }
  const valid = read([pin, cache])
  expect(valid).toMatchObject({
    status: 'ok',
    rejected: [],
    entries: [
      { entry: { locked: true } },
      { entry: { items: [{ resourceBindings: [pin, cache], access: { environment: [{ name: 'ASSET_ROOT', value: '{dependency:shared-assets}/assets' }] } }] } },
    ],
  })
  if (valid.status !== 'ok') throw new Error('Expected a readable catalog')
  expect(suiteCatalogViolations(valid.entries.map(row => row.entry))).toEqual([])
  const mismatch = read([{ ...pin, contentHash: 'b'.repeat(64) }])
  if (mismatch.status !== 'ok') throw new Error('Expected a readable catalog')
  expect(mismatch.rejected).toMatchObject([{ id: 'fixture-plugin', reason: 'invalid-entry' }])
  expect(suiteCatalogViolations(mismatch.entries.map(row => row.entry))).toContain(
    'fixture-plugin: resource binding requires exact locked dependency shared-assets',
  )
  for (const raw of [
    { ...dependency, locked: undefined, items: dependency.items.map(item => ({ ...item, locked: true })) },
    { ...dependency, items: dependency.items.map(item => ({ ...item, requiredFiles: undefined, check: { command: 'sh', args: ['./payload.sh'] } })) },
    { ...dependency, items: dependency.items.map(item => ({ ...item, check: { command: 'sh', args: ['./payload.sh'] } })) },
  ]) {
    const invalid = { ...raw, contentHash: suiteCatalogContentHash(raw) }
    expect(read([{ ...pin, contentHash: invalid.contentHash }], invalid)).toMatchObject({
      status: 'ok',
      rejected: expect.arrayContaining([{ id: 'shared-assets', version: dependency.version, reason: 'invalid-entry', detail: expect.any(String) }]),
    })
  }
  for (const bad of [
    { ...pin, name: 'NODE_OPTIONS' },
    { ...pin, path: '../assets' },
    { ...pin, path: '/tmp/assets' },
    { ...pin, path: 'assets/missing' },
    { ...cache, path: 'wrong-cache' },
    { ...cache, packages: [{ packageName: 'fixture-export', version: '^2.1.0' }] },
    { ...cache, packages: [{ packageName: 'fixture-editor', version: '1.0.0' }] },
    { ...cache, kind: 'execute' },
    { ...pin, kind: 'command-path', name: undefined },
  ])
    expect(read([bad])).toMatchObject({ status: 'ok', rejected: [{ id: 'fixture-plugin', reason: 'invalid-entry' }] })
  expect(read([pin], resource, [pin.dependency])).toMatchObject({ status: 'ok', rejected: [{ id: 'fixture-plugin', reason: 'invalid-entry' }] })
  expect(read([cache, cache])).toMatchObject({ status: 'ok', rejected: [{ id: 'fixture-plugin', reason: 'invalid-entry' }] })
  const executable = {
    ...dependency,
    items: dependency.items.map(item => ({
      ...item,
      requiredFiles: [{ path: 'bin/fixture-export', sha256: { arm64: 'c'.repeat(64) }, executable: true }],
    })),
  }
  const verifiedExecutable = { ...executable, contentHash: suiteCatalogContentHash(executable) }
  const commandPath = { ...pin, kind: 'command-path', name: undefined, path: 'bin', commands: ['fixture-export'], contentHash: verifiedExecutable.contentHash }
  const commands = read([commandPath], verifiedExecutable)
  expect(commands).toMatchObject({ status: 'ok', rejected: [] })
  if (commands.status !== 'ok') throw new Error('Expected a readable catalog')
  const command = (commands.entries[0]!.entry.items[0] as SuiteCatalogRuntimeDependencyItem).resourceChecks?.arm64
  expect(command).toContain("test -x './bin/fixture-export'")
  expect(command).toContain('/usr/bin/realpath')
  expect(command).toContain('/usr/bin/sha256sum')
  expect(read([{ ...commandPath, commands: ['fixture-export', 'missing'] }], verifiedExecutable)).toMatchObject({
    status: 'ok',
    rejected: [{ id: 'fixture-plugin', reason: 'invalid-entry' }],
  })
  expect(read([{ ...commandPath, path: 'bin/fixture-export' }], verifiedExecutable)).toMatchObject({
    status: 'ok',
    rejected: [{ id: 'fixture-plugin', reason: 'invalid-entry' }],
  })
})
