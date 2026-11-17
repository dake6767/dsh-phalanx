import { expect, it } from 'vitest'
import { busySuiteDependents, suiteCatalogView, suiteInstallView } from '../src/use-cases/suite-catalog-state.js'
import { withSuiteCatalogContentHash } from '../src/domain/suite-catalog-document.js'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { createCatalogSigningKey, signCatalog } from './fixtures/suite-catalog-signing.js'
import type { SuiteInstallRecord } from '../src/domain/suite-install.js'

const installed: SuiteInstallRecord = {
  id: 'suite',
  version: '1.0.0',
  status: 'installed',
  entries: [
    { kind: 'execution', name: 'writing' },
    { kind: 'execution', name: 'review' },
  ],
  updatedAt: 1,
  log: '',
}

it('projects committed delegated credential and enablement state', async () => {
  expect(
    await suiteInstallView(installed, [], {
      suiteExecutionStatus: async owner => ({ enabled: owner !== 'skill:review', configuredVariables: ['TOKEN'], missingCredentials: ['KEY'] }),
    }),
  ).toMatchObject({ status: 'installed', category: 'suite', execution: { enabled: false, configuredVariables: ['TOKEN'] }, missingCredentials: ['KEY'] })
})

it('blocks shared dependency changes for live install and recovery tasks, while settled or failed dependents do not block', () => {
  const dependent = { ...installed, dependencies: ['dependency'] }
  expect(
    busySuiteDependents(
      [
        { ...dependent, id: 'installing', status: 'installing' },
        { ...dependent, id: 'removing', status: 'uninstalling' },
        { ...dependent, id: 'settled' },
        { ...dependent, id: 'failed', status: 'failed' },
        { ...dependent, id: 'dependency', status: 'installing' },
      ],
      'dependency',
    ),
  ).toEqual(['installing', 'removing'])
})

it('derives links from accepted catalog plugin sources and leaves upgrade placeholders unlinked', async () => {
  const key = createCatalogSigningKey()
  const text = { en: 'Editor', 'zh-CN': '编辑器' }
  const item = {
    kind: 'plugin' as const,
    packageName: '@fixture/editor',
    version: '1.2.3',
    integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
    runtimeDependencies: [],
    catalogDependencies: [],
    access: { environment: [], entriesYaml: '' },
  }
  const npm = {
    kind: 'plugin' as const,
    id: 'fixture-npm',
    version: '1.0.0',
    engines: { platform: '>=0.1.24' },
    adapters: [],
    title: text,
    source: text,
    identity: text,
    description: text,
    dependencies: [],
    items: [item],
  }
  const archived = {
    ...npm,
    id: 'fixture-archive',
    engines: { platform: '>=0.1.35' },
    items: [{ ...item, archive: { url: 'https://github.com/fixture/editor/releases/download/v1.2.3/editor.tgz' } }],
  }
  const bytes = signCatalog([withSuiteCatalogContentHash(npm), withSuiteCatalogContentHash(archived)], key).bytes
  const project = async (platformVersion: string) => {
    const catalog = readSuiteCatalog(bytes, { platformVersion, trustedKeys: [key] })
    if (catalog.status !== 'ok') throw Error('Expected a verified catalog')
    return await suiteCatalogView(
      catalog.entries.map(({ entry }) => entry),
      { installs: [] },
      { status: 'ok', address: 'https://catalog.example.test/catalog.json' },
      undefined,
      async () => ({}),
    )
  }
  const [current, older] = await Promise.all([project('0.1.35'), project('0.1.34')])
  const npmLink = [{ label: '@fixture/editor', href: 'https://www.npmjs.com/package/@fixture/editor' }]
  expect(current.entries.map(entry => entry.sourceLinks)).toEqual([npmLink, [{ label: 'fixture/editor', href: 'https://github.com/fixture/editor' }]])
  expect(older.entries.map(entry => entry.sourceLinks)).toEqual([npmLink, undefined])
})

it('projects the plugin package and deduplicates GitHub commits pinned by resource downloads', async () => {
  const key = createCatalogSigningKey()
  const title = { en: 'OnlyOffice', 'zh-CN': 'OnlyOffice' }
  const commit = '99dbe255893b82fba46b82b337c571eb7d41f668'
  const repository = 'electroluxcode/onlyoffice-web-comp'
  const download = (target: string) => ({
    source: 'github-assets' as const,
    url: `https://github.com/${repository}/raw/${commit}/${target}`,
    sha256: { amd64: 'a'.repeat(64), arm64: 'a'.repeat(64) },
    target,
  })
  const entry = withSuiteCatalogContentHash({
    kind: 'plugin',
    id: 'onlyoffice',
    version: '9.8.7',
    engines: { platform: '>=0.1.35' },
    adapters: [],
    title,
    description: title,
    identity: title,
    source: { en: 'Package; resource', 'zh-CN': '安装包；资源' },
    dependencies: [],
    items: [
      {
        kind: 'runtime-dependency',
        type: 'resource',
        name: 'onlyoffice-sdk',
        commands: [],
        paths: [],
        downloads: [download('LICENSE'), download('sdk.js')],
      },
      {
        kind: 'plugin',
        packageName: '@dake6767/dsh-onlyoffice',
        version: '0.1.9',
        integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
        runtimeDependencies: ['onlyoffice-sdk'],
        catalogDependencies: [],
        access: { environment: [], entriesYaml: '' },
      },
    ],
  })
  const catalog = readSuiteCatalog(signCatalog([entry], key).bytes, { platformVersion: '0.1.37', trustedKeys: [key] })
  if (catalog.status !== 'ok') throw Error('Expected a verified catalog')
  const view = await suiteCatalogView(
    catalog.entries.map(row => row.entry),
    { installs: [] },
    { status: 'ok', address: 'https://catalog.example.test/catalog.json' },
    undefined,
    async () => ({}),
  )
  expect(view.entries[0]).toMatchObject({
    plugin: { packageName: '@dake6767/dsh-onlyoffice', version: '0.1.9' },
    dependencySources: [{ name: 'onlyoffice-sdk', repository, commit, href: `https://github.com/${repository}/tree/${commit}` }],
  })
})
