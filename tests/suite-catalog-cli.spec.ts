import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'
import { withSuiteCatalogContentHash } from '../src/domain/suite-catalog-document.js'

function check(entries: readonly unknown[], version = '0.1.19') {
  const root = mkdtempSync(join(tmpdir(), 'catalog-check-'))
  try {
    const path = join(root, 'catalog.json')
    writeFileSync(path, JSON.stringify({ format: 1, publishedAt: '2026-10-18T00:00:00Z', entries }))
    return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/check-suite-catalog.ts', path, version], { encoding: 'utf8' })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

it('checks an unsigned catalog through the exported CLI without requiring a signing key', () => {
  const result = check(onlineCatalogEntries.map(entry => withSuiteCatalogContentHash({ ...entry, engines: { platform: '>=0.1.19' } } as never)))
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('8 entries')
})

it('refuses incompatible platforms, invalid hashes, missing dependencies and command conflicts', () => {
  expect(check(onlineCatalogEntries, '0.1.17').status).toBe(1)
  expect(check([{ ...onlineCatalogEntries[0], contentHash: '0'.repeat(64) }]).stderr).toContain('content-hash-mismatch')
  const suite = onlineCatalogEntries.find(row => row.kind === 'suite')!
  expect(check([withSuiteCatalogContentHash({ ...suite, dependencies: ['missing'] } as never)]).stderr).toContain('unknown catalog dependency')
  const dependency = onlineCatalogEntries[0]!
  expect(check([dependency, withSuiteCatalogContentHash({ ...dependency, id: 'duplicate-provider' } as never)]).stderr).toContain('conflicts')
})

it('refuses adapter entries whose platform floor predates the adapter implementation', () => {
  const adapted = onlineCatalogEntries.find(row => (row.kind === 'suite' || row.kind === 'dependency') && row.adapters.length)!
  const result = check([withSuiteCatalogContentHash({ ...adapted, engines: { platform: '>=0.1.18' } } as never)])
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('>=0.1.19')
})

it('validates the declared plugin archive and its platform floor at publication', () => {
  const entry = {
    kind: 'plugin' as const,
    id: 'fixture-archive',
    version: '1.0.0',
    engines: { platform: '>=0.1.35' },
    adapters: [],
    title: { en: 'Editor', 'zh-CN': '编辑器' },
    description: { en: 'Editor', 'zh-CN': '编辑器' },
    identity: { en: 'Editor', 'zh-CN': '编辑器' },
    source: { en: 'Fixture', 'zh-CN': '夹具' },
    dependencies: [],
    items: [
      {
        kind: 'plugin' as const,
        packageName: '@fixture/editor',
        version: '1.0.0',
        integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
        runtimeDependencies: [],
        catalogDependencies: [],
        access: { environment: [], entriesYaml: '' },
        archive: { url: 'https://github.com/fixture/editor/releases/download/v1.0.0/editor.tgz' },
      },
    ],
  }
  const valid = check([withSuiteCatalogContentHash(entry)], '0.1.35')
  expect(valid.status, valid.stderr).toBe(0)
  const unsafe = check([withSuiteCatalogContentHash({ ...entry, engines: { platform: '>=0.1.34' } })], '0.1.35')
  expect(unsafe.status).toBe(1)
  expect(unsafe.stderr).toContain('>=0.1.35')
  const [plugin] = entry.items
  const { archive, ...npmPlugin } = plugin!
  const misplacedEntry = { ...entry, archive, items: [npmPlugin], engines: { platform: '>=0.1.34' } }
  const misplaced = check([withSuiteCatalogContentHash(misplacedEntry)], '0.1.35')
  expect(misplaced.status).toBe(1)
  expect(misplaced.stderr).toContain('Catalog extension is declared at the wrong level')
})
