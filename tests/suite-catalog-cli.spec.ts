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
  } finally { rmSync(root, { recursive: true, force: true }) }
}

it('checks an unsigned catalog through the exported CLI without requiring a signing key', () => {
  const result = check(onlineCatalogEntries.map(entry => withSuiteCatalogContentHash({ ...entry, engines: { platform: ">=0.1.19" } } as never)))
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
