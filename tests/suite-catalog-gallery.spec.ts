import { suiteOriginName } from '../src/domain/suite-catalog.js'
import { expect, it } from 'vitest'
import { defaultSuiteCatalogAsset } from '../src/domain/suite-catalog-source.js'
import { resolveDownloadSources } from '../src/domain/download-source.js'
import { withSuiteCatalogContentHash, type SuiteCatalogDocumentEntry } from '../src/domain/suite-catalog-document.js'
import { SuiteCatalogGallery } from '../src/use-cases/suite-catalog-gallery.js'
import type { SuiteInstallState } from '../src/domain/suite-install.js'
import { createCatalogSigningKey, signCatalog } from './fixtures/suite-catalog-signing.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

const key = createCatalogSigningKey()

function fixture(
  options: {
    readonly entries?: readonly SuiteCatalogDocumentEntry[]
    readonly state?: SuiteInstallState
    readonly configuredAddress?: string
    readonly fail?: string
  } = {},
) {
  const state = options.state ?? { installs: [] }
  const calls: string[] = []
  const gallery = new SuiteCatalogGallery({
    ...(options.configuredAddress ? { configuredAddress: options.configuredAddress } : {}),
    trustedKeys: [key],
    platformVersion: '0.1.19',
    installs: async () => structuredClone(state.installs),
    downloads: { current: () => resolveDownloadSources({ preset: 'mainland' }) },
    fetcher: {
      read: async address => {
        calls.push(address)
        if (options.fail) throw new Error(options.fail)
        return signCatalog(options.entries ?? onlineCatalogEntries, key).bytes
      },
    },
  })
  return { gallery, calls, state }
}

it('loads the signed catalog, exposes the source state', async () => {
  const f = fixture()
  expect(f.gallery.entries().map(entry => entry.id)).toEqual([])
  const source = await f.gallery.load()
  expect(source).toMatchObject({ status: 'ok', address: 'https://ghfast.top/' + defaultSuiteCatalogAsset })
  expect(source.publishedAt).toBe('2026-10-18T00:00:00.000Z')
  expect(f.gallery.entries().map(entry => entry.id)).toEqual(['pandoc', 'ffmpeg', 'chromium', 'wecom', 'officecli', 'minimax', 'lark', 'hyperframes'])
  expect(f.calls).toEqual(['https://ghfast.top/' + defaultSuiteCatalogAsset])
})

it('uses a configured address as given and fetches again on every load without caching', async () => {
  const f = fixture({ configuredAddress: 'https://catalog.example.test/catalog.json' })
  await f.gallery.load()
  expect(f.gallery.source().address).toBe('https://catalog.example.test/catalog.json')
  await f.gallery.load()
  expect(f.calls).toHaveLength(2)
})

it('clears entries when the service is unreachable and reports the address and reason', async () => {
  const f = fixture({ fail: 'The catalog service answered HTTP 503.' })
  const source = await f.gallery.load()
  expect(source).toMatchObject({ status: 'unreachable', reason: 'The catalog service answered HTTP 503.' })
  expect(f.gallery.entries().map(entry => entry.id)).toEqual([])
})

it('clears entries when the document is rejected and reports a stable reason', async () => {
  const unknownKey = createCatalogSigningKey('unknown')
  const f = new SuiteCatalogGallery({
    trustedKeys: [key],
    platformVersion: '0.1.19',
    installs: async () => [],
    downloads: { current: () => resolveDownloadSources({ preset: 'official' }) },
    fetcher: { read: async () => signCatalog(onlineCatalogEntries, unknownKey).bytes },
  })
  expect(await f.load()).toMatchObject({ status: 'rejected', reason: 'unknown-key' })
  expect(f.entries()).toEqual([])
})

it('drops the online entries again when a later load fails, so nothing stale is cached', async () => {
  let fail = false
  const gallery = new SuiteCatalogGallery({
    trustedKeys: [key],
    platformVersion: '0.1.19',
    installs: async () => [],
    downloads: { current: () => resolveDownloadSources({ preset: 'official' }) },
    fetcher: {
      read: async () => {
        if (fail) throw new Error('offline')
        return signCatalog(onlineCatalogEntries, key).bytes
      },
    },
  })
  await gallery.load()
  expect(gallery.entries()).toHaveLength(onlineCatalogEntries.length)
  fail = true
  expect(await gallery.load()).toMatchObject({ status: 'unreachable' })
  expect(gallery.entries()).toHaveLength(0)
})

it('marks an entry whose installed version content changed as tampered and keeps it visible', async () => {
  const entry = onlineCatalogEntries.find(row => row.id === 'pandoc')!
  const state: SuiteInstallState = {
    installs: [{ id: 'pandoc', version: entry.version, status: 'installed', contentHash: 'f'.repeat(64), entries: [], updatedAt: 0, log: '' }],
  }
  const f = fixture({ state })
  const source = await f.gallery.load()
  expect(source.status).toBe('ok')
  expect(f.gallery.entries().find(row => row.id === 'pandoc')).toMatchObject({ unavailableReason: 'content-tampered' })
})

it('accepts the installed content hash for an unchanged id and version', async () => {
  const entry = onlineCatalogEntries.find(row => row.id === 'pandoc')!
  const f = fixture({
    state: { installs: [{ id: 'pandoc', version: entry.version, status: 'installed', contentHash: entry.contentHash, entries: [], updatedAt: 0, log: '' }] },
  })
  await f.gallery.load()
  expect(f.gallery.entries().find(row => row.id === 'pandoc')?.unavailableReason).toBeUndefined()
})

it('awaits current installation rows on every load before checking same-version content integrity', async () => {
  const entry = onlineCatalogEntries.find(row => row.id === 'pandoc')!
  let contentHash = entry.contentHash
  const gallery = new SuiteCatalogGallery({
    trustedKeys: [key],
    platformVersion: '0.1.19',
    installs: async () => [{ id: 'pandoc', version: entry.version, contentHash, status: 'installed', entries: [], updatedAt: 0, log: '' }],
    downloads: { current: () => resolveDownloadSources({ preset: 'official' }) },
    fetcher: { read: async () => signCatalog(onlineCatalogEntries, key).bytes },
  })
  expect((await gallery.load()).status).toBe('ok')
  expect(gallery.entries().find(row => row.id === 'pandoc')?.unavailableReason).toBeUndefined()
  contentHash = 'f'.repeat(64)
  expect((await gallery.load()).status).toBe('ok')
  expect(gallery.entries().find(row => row.id === 'pandoc')?.unavailableReason).toBe('content-tampered')
})

it('keeps signed entries that need a newer platform visible but unavailable', async () => {
  const base = onlineCatalogEntries[0]!
  if (base.kind !== 'dependency' && base.kind !== 'suite') throw new Error('reserved entry kind')
  const newer = withSuiteCatalogContentHash({ ...base, id: 'newer', engines: { platform: '>=999.0.0' } })
  const f = fixture({ entries: [newer] })
  await f.gallery.load()
  expect(f.gallery.entries().find(row => row.id === 'newer')).toMatchObject({ unavailableReason: 'needs-platform-upgrade' })
})

it('keeps the online entry from the online source', async () => {
  const base = onlineCatalogEntries.find(row => row.id === 'wecom')!
  const f = fixture({ entries: [base] })
  await f.gallery.load()
  expect(f.gallery.entries().map(entry => entry.id)).toEqual(['wecom'])
  expect(f.gallery.entries()[0]?.contentHash).toBe(base.contentHash)
})

it('logs entry kinds this platform version does not render', async () => {
  const lines: string[] = []
  const reserved = withSuiteCatalogContentHash({ ...(onlineCatalogEntries[0] as never as Record<string, unknown>), kind: 'mcp', id: 'reserved' } as never)
  const keys = createCatalogSigningKey()
  const gallery = new SuiteCatalogGallery({
    trustedKeys: [keys],
    platformVersion: '0.1.19',
    installs: async () => [],
    downloads: { current: () => resolveDownloadSources({ preset: 'official' }) },
    log: line => {
      lines.push(line)
    },
    fetcher: { read: async () => signCatalog([reserved], keys).bytes },
  })
  await gallery.load()
  expect(lines.some(line => line.includes('mcp:reserved'))).toBe(true)
})

it('shares one in-flight request between concurrent gallery loads', async () => {
  let release = (): void => {}
  let calls = 0
  const gallery = new SuiteCatalogGallery({
    trustedKeys: [key],
    platformVersion: '0.1.19',
    installs: async () => [],
    downloads: { current: () => resolveDownloadSources({ preset: 'official' }) },
    fetcher: {
      read: async () => {
        calls++
        await new Promise<void>(resolve => {
          release = resolve
        })
        return signCatalog(onlineCatalogEntries, key).bytes
      },
    },
  })
  const first = gallery.load(),
    second = gallery.load()
  await Promise.resolve()
  release()
  const [a, b] = await Promise.all([first, second])
  expect(calls).toBe(1)
  expect(a).toEqual(b)
})

it('validates the configured or test catalog address like the environment loader', () => {
  const input = {
    trustedKeys: [key],
    platformVersion: '0.1.19',
    installs: async () => [],
    downloads: { current: () => resolveDownloadSources({ preset: 'official' }) },
    fetcher: { read: async () => new Uint8Array() },
  }
  for (const configuredAddress of [
    'ftp://catalog.example.test/catalog.json',
    'https://user:secret@catalog.example.test/catalog.json',
    'https://catalog.example.test/catalog.json?x=1',
    'not-a-url',
  ])
    expect(() => new SuiteCatalogGallery({ ...input, configuredAddress })).toThrow()
  expect(new SuiteCatalogGallery({ ...input, configuredAddress: 'https://catalog.example.test/catalog.json' }).address()).toBe(
    'https://catalog.example.test/catalog.json',
  )
})

it('does not let an aborted caller signal poison a coalesced load', async () => {
  let rejectFirst = (): void => {}
  const gallery = new SuiteCatalogGallery({
    trustedKeys: [key],
    platformVersion: '0.1.19',
    installs: async () => [],
    downloads: { current: () => resolveDownloadSources({ preset: 'official' }) },
    fetcher: {
      read: async (_address, signal) => {
        if (signal.aborted) throw new Error('aborted')
        await new Promise<void>((resolve, reject) => {
          rejectFirst = resolve
          signal.addEventListener('abort', () => reject(new Error('aborted')))
        })
        return signCatalog(onlineCatalogEntries, key).bytes
      },
    },
  })
  const controller = new AbortController()
  const aborted = gallery.load(controller.signal)
  controller.abort()
  // A caller-owned signal only cancels that caller's request; load() reports the failure instead of rejecting.
  expect(await aborted).toMatchObject({ status: 'unreachable', reason: 'aborted' })
  // The shared load path still fetches successfully afterwards.
  const second = gallery.load()
  await Promise.resolve()
  rejectFirst()
  expect(await second).toMatchObject({ status: 'ok' })
  expect(gallery.entries()).toHaveLength(onlineCatalogEntries.length)
})

it('names suite origins from loaded localized titles and falls back to the id offline', async () => {
  const f = fixture()
  await f.gallery.load()
  expect(suiteOriginName('suite:wecom', 'zh-CN', f.gallery.entries())).toBe('企业微信')
  expect(suiteOriginName('suite:wecom', 'en', f.gallery.entries())).toBe('WeCom')
  expect(suiteOriginName('suite:missing', 'en', f.gallery.entries())).toBe('missing')
  expect(suiteOriginName('suite:wecom')).toBe('wecom')
})
