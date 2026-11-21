import { expect, it } from 'vitest'
import { suiteCatalogContentHash } from '../src/domain/suite-catalog-document.js'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { createCatalogSigningKey, signRawCatalog } from './fixtures/suite-catalog-signing.js'

const key = createCatalogSigningKey()
const label = { en: 'Browser fixture', 'zh-CN': '浏览器夹具' }
const base = { version: '1.0.0', title: label, description: label, source: label, adapters: [], identity: label }

function browserResource(id: string, marker = 'a') {
  const entry = {
    ...base,
    kind: 'dependency',
    id,
    engines: { platform: '>=0.1.35' },
    locked: true,
    items: [
      {
        kind: 'runtime-dependency',
        type: 'resource',
        name: id,
        paths: [],
        commands: [],
        downloads: [
          {
            source: 'github-assets',
            url: { arm64: 'https://github.com/fixture/browser/releases/download/v1/assets.tgz' },
            sha256: { arm64: marker.repeat(64) },
            target: 'assets.tgz',
            extract: { format: 'tar' },
          },
        ],
        requiredFiles: [{ path: 'assets/chromium_headless_shell-1248/chrome-headless-shell', sha256: { arm64: marker.repeat(64) }, executable: true }],
      },
    ],
  }
  return { ...entry, contentHash: suiteCatalogContentHash(entry) }
}

function pluginEntry(id: string, dependency: string, binding: unknown, minimum = '0.1.39') {
  const entry = {
    ...base,
    kind: 'plugin',
    id,
    engines: { platform: '>=' + minimum },
    dependencies: [dependency],
    items: [
      {
        kind: 'plugin',
        packageName: id,
        version: '1.0.0',
        integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
        runtimeDependencies: [],
        catalogDependencies: [dependency],
        access: { environment: [], entriesYaml: '' },
        resourceBindings: [binding],
      },
    ],
  }
  return { ...entry, contentHash: suiteCatalogContentHash(entry) }
}

const read = (entries: readonly object[], version = '0.1.39') =>
  readSuiteCatalog(signRawCatalog({ format: 1, publishedAt: '2026-11-11T00:00:00Z', entries }, key), {
    trustedKeys: [key],
    platformVersion: version,
  })

it('shares one signed browser build across plugins without declaring duplicate environment variables', () => {
  const shared = browserResource('shared-cache')
  const other = browserResource('other-cache', 'b')
  const browser = {
    kind: 'playwright-browser',
    dependency: shared.id,
    version: shared.version,
    contentHash: shared.contentHash,
    path: 'assets',
    playwrightVersion: '1.64.1',
    chromiumBuild: '1248',
    directories: ['chromium_headless_shell-1248'],
  }
  const first = pluginEntry('editor-browser', shared.id, browser)
  const second = pluginEntry('diagram-browser', shared.id, { ...browser, playwrightVersion: '1.64.2' })
  expect(read([shared, first, second])).toMatchObject({
    status: 'ok',
    rejected: [],
    entries: [
      { entry: { id: shared.id, locked: true } },
      { entry: { items: [{ resourceBindings: [browser], access: { environment: [] } }] } },
      { entry: { items: [{ access: { environment: [] } }] } },
    ],
  })
  const conflict = pluginEntry('diagram-browser', other.id, { ...browser, dependency: other.id, contentHash: other.contentHash })
  expect(read([shared, other, first, conflict])).toMatchObject({
    status: 'ok',
    rejected: expect.arrayContaining([expect.objectContaining({ id: first.id }), expect.objectContaining({ id: conflict.id })]),
  })
  for (const bad of [
    { ...browser, chromiumBuild: '1217', directories: ['chromium_headless_shell-1217'] },
    { ...browser, directories: ['../chromium_headless_shell-1248'] },
    { ...browser, playwrightVersion: '^1.64.1' },
    { ...browser, name: 'PLAYWRIGHT_BROWSERS_PATH' },
  ])
    expect(read([shared, pluginEntry('editor-browser', shared.id, bad)])).toMatchObject({
      status: 'ok',
      rejected: [{ id: first.id, reason: 'invalid-entry' }],
    })
  expect(read([shared, pluginEntry('editor-browser', shared.id, browser, '0.1.35')])).toMatchObject({
    status: 'ok',
    rejected: [{ id: first.id, reason: 'invalid-entry' }],
  })
  expect(read([shared, first], '0.1.38')).toMatchObject({
    status: 'ok',
    rejected: [{ id: first.id, reason: 'needs-platform-upgrade' }],
  })
})

it('reuses the exact locked browser archive identified by an existing signed environment binding', () => {
  const original = browserResource('legacy-cache')
  const resource = {
    ...original,
    items: [
      {
        ...original.items[0],
        requiredFiles: [{ path: 'assets/dsh-chromium', sha256: { arm64: 'a'.repeat(64) }, executable: true }],
      },
    ],
  }
  const shared = { ...resource, contentHash: suiteCatalogContentHash(resource) }
  const pin = { dependency: shared.id, version: shared.version, contentHash: shared.contentHash, path: 'assets' }
  const originalPlugin = pluginEntry('original-browser', shared.id, { ...pin, kind: 'environment', name: 'PLAYWRIGHT_BROWSERS_PATH' }, '0.1.35')
  const newPlugin = pluginEntry('editor-browser', shared.id, {
    ...pin,
    kind: 'playwright-browser',
    playwrightVersion: '1.59.1',
    chromiumBuild: '1217',
    directories: ['chromium_headless_shell-1217'],
  })

  expect(read([shared, originalPlugin, newPlugin])).toMatchObject({
    status: 'ok',
    rejected: [],
    entries: [{ entry: { id: shared.id } }, { entry: { id: originalPlugin.id } }, { entry: { id: newPlugin.id } }],
  })
  const unrelatedPlugin = pluginEntry('original-browser', shared.id, { ...pin, kind: 'environment', name: 'UNRELATED' }, '0.1.35')
  for (const entries of [
    [shared, newPlugin],
    [shared, unrelatedPlugin, newPlugin],
  ])
    expect(read(entries)).toMatchObject({ status: 'ok', rejected: [{ id: newPlugin.id, reason: 'invalid-entry' }] })
})
