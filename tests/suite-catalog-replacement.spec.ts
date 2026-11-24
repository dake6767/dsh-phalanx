import { expect, it } from 'vitest'
import { withSuiteCatalogContentHash } from '../src/domain/suite-catalog-document.js'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { createCatalogSigningKey, signCatalog } from './fixtures/suite-catalog-signing.js'

it('reads only an exact version-gated predecessor for a signed plugin replacement', () => {
  const key = createCatalogSigningKey()
  const replaces = { version: '1.2.1000', integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64') }
  const item = {
    kind: 'plugin' as const,
    packageName: '@fixture/editor',
    version: '1.2.4',
    integrity: 'sha512-' + Buffer.alloc(64, 2).toString('base64'),
    replaces,
    runtimeDependencies: [],
    catalogDependencies: [],
    access: { environment: [], entriesYaml: '' },
  }
  const entry = {
    version: '1.0.0',
    adapters: [],
    title: { en: 'Editor', 'zh-CN': '编辑器' },
    description: { en: 'Fixture', 'zh-CN': '夹具' },
    source: { en: 'fixture', 'zh-CN': '夹具' },
    kind: 'plugin' as const,
    id: 'fixture-official',
    dependencies: [],
    identity: { en: 'Editor', 'zh-CN': '编辑器' },
    engines: { platform: '>=0.1.41' },
    items: [item],
  }
  const read = (declaration = entry, platformVersion = '0.1.41') =>
    readSuiteCatalog(signCatalog([withSuiteCatalogContentHash(declaration)], key).bytes, { trustedKeys: [key], platformVersion })
  expect(read()).toMatchObject({ status: 'ok', rejected: [], entries: [{ entry: { items: [{ replaces }] } }] })
  expect(read(entry, '0.1.40')).toMatchObject({ rejected: [{ reason: 'needs-platform-upgrade' }] })
  expect(read({ ...entry, engines: { platform: '>=0.1.40' } })).toMatchObject({ rejected: [{ reason: 'invalid-entry' }] })
  for (const invalid of [
    { ...replaces, integrity: 'invalid' },
    { ...replaces, integrity: item.integrity },
    { ...replaces, version: '1.2.3' },
    { ...replaces, packageName: 'other' },
  ]) {
    expect(read({ ...entry, items: [{ ...item, replaces: invalid }] })).toMatchObject({ rejected: [{ reason: 'invalid-entry' }] })
  }
})
