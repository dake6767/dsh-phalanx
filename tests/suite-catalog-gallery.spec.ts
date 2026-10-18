import { expect, it, vi } from 'vitest'
import { suiteCatalog as bundledSuiteCatalog } from '../src/domain/suite-catalog.js'
import { defaultSuiteCatalogAsset } from '../src/domain/suite-catalog-source.js'
import { resolveDownloadSources } from '../src/domain/download-source.js'
import { withSuiteCatalogContentHash, type SuiteCatalogDocumentEntry } from '../src/domain/suite-catalog-document.js'
import { SuiteCatalogGallery } from '../src/use-cases/suite-catalog-gallery.js'
import type { SuiteInstallState } from '../src/domain/suite-install.js'
import { createCatalogSigningKey, signCatalog } from './fixtures/suite-catalog-signing.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

const key = createCatalogSigningKey()
const builtin = bundledSuiteCatalog

function fixture(options: { readonly entries?: readonly SuiteCatalogDocumentEntry[], readonly state?: SuiteInstallState, readonly configuredAddress?: string, readonly fail?: string } = {}) {
  const state = options.state ?? { installs: [] }
  const calls: string[] = []
  const gallery = new SuiteCatalogGallery({
    builtin, ...(options.configuredAddress ? { configuredAddress: options.configuredAddress } : {}),
    trustedKeys: [key], platformVersion: '0.1.19', installs: { read: () => structuredClone(state) },
    downloads: { current: () => resolveDownloadSources({ preset: 'mainland' }) },
    fetcher: { read: async address => {
      calls.push(address)
      if (options.fail) throw new Error(options.fail)
      return signCatalog(options.entries ?? onlineCatalogEntries, key).bytes
    } },
  })
  return { gallery, calls, state }
}

it('loads the signed catalog, merges it behind the bundled entries and exposes the source state', async () => {
  const f = fixture()
  expect(f.gallery.entries().map(entry => entry.id)).toEqual(['hyperframes', 'officecli', 'lark', 'minimax'])
  const source = await f.gallery.load()
  expect(source).toMatchObject({ status: 'ok', address: 'https://ghfast.top/' + defaultSuiteCatalogAsset })
  expect(source.publishedAt).toBe('2026-10-18T00:00:00.000Z')
  expect(f.gallery.entries().map(entry => entry.id)).toEqual(['hyperframes', 'officecli', 'lark', 'minimax', 'pandoc', 'ffmpeg', 'chromium', 'wecom'])
  expect(f.calls).toEqual(['https://ghfast.top/' + defaultSuiteCatalogAsset])
})

it('uses a configured address as given and fetches again on every load without caching', async () => {
  const f = fixture({ configuredAddress: 'https://catalog.example.test/catalog.json' })
  await f.gallery.load()
  expect(f.gallery.source().address).toBe('https://catalog.example.test/catalog.json')
  await f.gallery.load()
  expect(f.calls).toHaveLength(2)
})

it('keeps only bundled entries when the service is unreachable and reports the address and reason', async () => {
  const f = fixture({ fail: 'The catalog service answered HTTP 503.' })
  const source = await f.gallery.load()
  expect(source).toMatchObject({ status: 'unreachable', reason: 'The catalog service answered HTTP 503.' })
  expect(f.gallery.entries().map(entry => entry.id)).toEqual(['hyperframes', 'officecli', 'lark', 'minimax'])
})

it('keeps only bundled entries when the document is rejected and reports a stable reason', async () => {
  const unknownKey = createCatalogSigningKey('unknown')
  const f = new SuiteCatalogGallery({ builtin, trustedKeys: [key], platformVersion: '0.1.19', installs: { read: () => ({ installs: [] }) },
    downloads: { current: () => resolveDownloadSources({ preset: 'official' }) },
    fetcher: { read: async () => signCatalog(onlineCatalogEntries, unknownKey).bytes } })
  expect(await f.load()).toMatchObject({ status: 'rejected', reason: 'unknown-key' })
  expect(f.entries().map(entry => entry.id)).toEqual(['hyperframes', 'officecli', 'lark', 'minimax'])
})

it('drops the online entries again when a later load fails, so nothing stale is cached', async () => {
  let fail = false
  const gallery = new SuiteCatalogGallery({ builtin, trustedKeys: [key], platformVersion: '0.1.19', installs: { read: () => ({ installs: [] }) },
    downloads: { current: () => resolveDownloadSources({ preset: 'official' }) },
    fetcher: { read: async () => { if (fail) throw new Error('offline'); return signCatalog(onlineCatalogEntries, key).bytes } } })
  await gallery.load()
  expect(gallery.entries()).toHaveLength(builtin.length + onlineCatalogEntries.length)
  fail = true
  expect(await gallery.load()).toMatchObject({ status: 'unreachable' })
  expect(gallery.entries()).toHaveLength(builtin.length)
})

it('marks an entry whose installed version content changed as tampered and keeps it visible', async () => {
  const entry = onlineCatalogEntries.find(row => row.id === 'pandoc')!
  const state: SuiteInstallState = { installs: [{ id: 'pandoc', version: entry.version, status: 'installed', contentHash: 'f'.repeat(64), entries: [], updatedAt: 0, log: '' }] }
  const f = fixture({ state })
  const source = await f.gallery.load()
  expect(source.status).toBe('ok')
  expect(f.gallery.entries().find(row => row.id === 'pandoc')).toMatchObject({ unavailableReason: 'content-tampered' })
})

it('accepts the installed content hash for an unchanged id and version', async () => {
  const entry = onlineCatalogEntries.find(row => row.id === 'pandoc')!
  const f = fixture({ state: { installs: [{ id: 'pandoc', version: entry.version, status: 'installed', contentHash: entry.contentHash, entries: [], updatedAt: 0, log: '' }] } })
  await f.gallery.load()
  expect(f.gallery.entries().find(row => row.id === 'pandoc')?.unavailableReason).toBeUndefined()
})

it('keeps signed entries that need a newer platform visible but unavailable', async () => {
  const base = onlineCatalogEntries[0]!
  if (base.kind !== 'dependency' && base.kind !== 'suite') throw new Error('reserved entry kind')
  const newer = withSuiteCatalogContentHash({ ...base, id: 'newer', engines: { platform: '>=999.0.0' } })
  const f = fixture({ entries: [newer] })
  await f.gallery.load()
  expect(f.gallery.entries().find(row => row.id === 'newer')).toMatchObject({ unavailableReason: 'needs-platform-upgrade' })
})

it('ignores an online entry whose id a bundled entry owns', async () => {
  const base = onlineCatalogEntries.find(row => row.id === 'pandoc')!
  if (base.kind !== 'dependency' && base.kind !== 'suite') throw new Error('reserved entry kind')
  const shadow = withSuiteCatalogContentHash({ ...base, id: 'lark' })
  const f = fixture({ entries: [shadow] })
  await f.gallery.load()
  expect(f.gallery.entries().filter(entry => entry.id === 'lark')).toHaveLength(1)
  expect(f.gallery.entries().find(entry => entry.id === 'lark')?.contentHash).toBeUndefined()
})

it('logs entry kinds this platform version does not render', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const reserved = withSuiteCatalogContentHash({ ...(onlineCatalogEntries[0] as never as Record<string, unknown>), kind: 'plugin', id: 'reserved' } as never)
  const f = fixture({ entries: [reserved] })
  try {
    await f.gallery.load()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('plugin:reserved'))
  } finally { warn.mockRestore() }
})
