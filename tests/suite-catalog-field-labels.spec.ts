import { expect, it } from 'vitest'
import { suiteCatalogContentHash } from '../src/domain/suite-catalog-document.js'
import { checkUnsignedSuiteCatalog, readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { createCatalogSigningKey, signRawCatalog } from './fixtures/suite-catalog-signing.js'

const key = createCatalogSigningKey()
const title = { en: 'Fixture', 'zh-CN': '夹具' }
const modelLabel = { en: 'Model name', 'zh-CN': '模型名称' }
const modelField = { name: 'MODEL', type: 'text', required: true }
const declaration = { slot: 'image', backend: 'openai', field: 'MODEL', label: modelLabel }

function catalog(serviceFieldLabels?: unknown) {
  const entry = {
    kind: 'plugin',
    id: 'fixture-editor',
    version: '1.0.0',
    engines: { platform: '>=0.1.35' },
    adapters: [],
    title,
    description: title,
    source: title,
    identity: title,
    dependencies: [],
    items: [
      {
        kind: 'plugin',
        packageName: 'fixture-editor',
        version: '1.0.0',
        integrity: 'sha512-' + Buffer.alloc(64, 1).toString('base64'),
        runtimeDependencies: [],
        catalogDependencies: [],
        access: { environment: [], entriesYaml: '' },
        serviceSlots: [
          {
            id: 'image',
            label: title,
            binding: {
              kind: 'revisioned-rpc',
              service: 'fixtureSettings',
              active: ['settings', 'image'],
              selection: ['settings', 'image', 'selected'],
              profiles: ['settings', 'image', 'profiles'],
              idKey: 'id',
              snapshotKey: 'snapshot',
              fields: { endpoint: 'baseUrl', key: 'apiKey', model: 'model', mode: 'engine' },
            },
            backends: [
              {
                id: 'openai',
                label: title,
                protocol: 'openai-image',
                mode: 'api',
                upstream: { model: 'MODEL', endpoint: 'URL', key: 'KEY' },
                fields: [{ name: 'URL', type: 'url', required: true }, { name: 'KEY', type: 'secret', required: true }, modelField],
              },
            ],
          },
        ],
        ...(serviceFieldLabels === undefined ? {} : { serviceFieldLabels }),
      },
    ],
  }
  return { format: 1, publishedAt: '2026-11-11T00:00:00Z', entries: [{ ...entry, contentHash: suiteCatalogContentHash(entry) }] }
}
function signedRead(raw: ReturnType<typeof catalog>) {
  return readSuiteCatalog(signRawCatalog(raw, key), { trustedKeys: [key], platformVersion: '0.1.36' })
}

it('projects optional signed field labels without changing the original field declaration', () => {
  expect(signedRead(catalog())).toMatchObject({ status: 'ok', rejected: [] })
  const raw = catalog([declaration])
  expect(checkUnsignedSuiteCatalog(raw, '0.1.36')).toMatchObject({ status: 'ok', rejected: [] })
  expect(signedRead(raw)).toMatchObject({
    status: 'ok',
    rejected: [],
    entries: [{ entry: { items: [{ serviceSlots: [{ backends: [{ fields: expect.arrayContaining([{ ...modelField, label: modelLabel }]) }] }] }] } }],
  })
})

it('rejects labels with duplicate, unknown or malformed field references at both catalog boundaries', () => {
  for (const labels of [[declaration, declaration], [{ ...declaration, field: 'UNKNOWN' }], [{ ...declaration, label: { en: '' } }]]) {
    const raw = catalog(labels)
    expect(checkUnsignedSuiteCatalog(raw, '0.1.36')).toMatchObject({ status: 'ok', rejected: [{ reason: 'invalid-entry' }] })
    expect(signedRead(raw)).toMatchObject({ status: 'ok', rejected: [{ reason: 'invalid-entry' }] })
  }
})
