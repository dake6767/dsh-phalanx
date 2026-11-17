import { expect, it } from 'vitest'
import { checkUnsignedSuiteCatalog, readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { suiteCatalogContentHash } from '../src/domain/suite-catalog-document.js'
import { createCatalogSigningKey, signRawCatalog } from './fixtures/suite-catalog-signing.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

const key = createCatalogSigningKey()
const options = { trustedKeys: [key], platformVersion: '0.1.36' }

it('verifies gallery tags without changing entry identity and isolates malformed display metadata online', () => {
  const entry = onlineCatalogEntries.find(row => row.id === 'wecom')!
  const raw = {
    format: 1,
    publishedAt: '2026-11-17T00:00:00Z',
    entries: [entry],
    galleryTags: {
      tags: [{ id: 'team', label: { en: 'Team', 'zh-CN': '团队' } }],
      assignments: [{ kind: 'suite', id: entry.id, tags: ['team'] }],
    },
  }
  const result = readSuiteCatalog(signRawCatalog(raw, key), options)
  expect(result).toMatchObject({ status: 'ok', galleryTags: raw.galleryTags, entries: [{ contentHash: entry.contentHash }] })
  const invalid = { ...raw, galleryTags: { ...raw.galleryTags, assignments: [{ kind: 'mcp', id: entry.id, tags: ['team'] }] } }
  const isolated = readSuiteCatalog(signRawCatalog(invalid, key), options)
  expect(isolated).toMatchObject({ status: 'ok', entries: [{ contentHash: entry.contentHash }] })
  if (isolated.status === 'ok') expect(isolated.galleryTags).toBeUndefined()
  expect(checkUnsignedSuiteCatalog(invalid, options.platformVersion)).toMatchObject({ status: 'rejected', reason: 'invalid-document' })
  const tampered = JSON.parse(signRawCatalog(raw, key).toString('utf8'))
  tampered.galleryTags.tags[0].label.en = 'Other'
  expect(readSuiteCatalog(Buffer.from(JSON.stringify(tampered)), options)).toMatchObject({ status: 'rejected', reason: 'invalid-signature' })
})

it('compiles a compatible signed MCP declaration and refuses executable or unpinned extensions', () => {
  const declaration = {
    kind: 'mcp',
    id: 'rail',
    version: '1.0.0',
    engines: { platform: '>=0.1.37' },
    title: { en: 'Rail', 'zh-CN': '铁路' },
    description: { en: 'Timetables', 'zh-CN': '时刻表' },
    source: { en: 'Rail', 'zh-CN': '铁路' },
    documentation: 'https://github.com/owner/rail',
    adapters: [
      {
        name: 'mcp-shared-node',
        params: { repository: 'owner/rail', commit: 'a'.repeat(40), sha256: 'b'.repeat(64), script: 'build/index.js' },
      },
    ],
  } as const
  const read = (spec: typeof declaration | object) =>
    readSuiteCatalog(
      signRawCatalog(
        {
          format: 1,
          publishedAt: '2026-11-17T00:00:00Z',
          entries: [{ ...spec, contentHash: suiteCatalogContentHash(spec) }],
        },
        key,
      ),
      { ...options, platformVersion: '0.1.37' },
    )
  expect(read(declaration)).toMatchObject({
    status: 'ok',
    mcp: [
      {
        entry: { id: 'rail', location: 'shared', contentHash: suiteCatalogContentHash(declaration) },
        configuration: { run: { command: 'node', args: ['{dependencies}/source/build/index.js'] } },
      },
    ],
  })
  expect(read({ ...declaration, prepareCommand: 'arbitrary-command' })).toMatchObject({
    status: 'ok',
    rejected: [{ id: 'rail', reason: 'invalid-adapter-params' }],
  })
  expect(read({ ...declaration, engines: { platform: '>=0.1.36' } })).toMatchObject({
    status: 'ok',
    rejected: [{ id: 'rail', reason: 'invalid-entry' }],
  })
})
