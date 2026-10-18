import { expect, it } from 'vitest'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { suiteCatalog } from '../src/domain/suite-catalog.js'
import { suiteCatalogViolations, type SuiteCatalogCheckEntry } from '../src/domain/suite-catalog-checks.js'
import { createCatalogSigningKey, signCatalog } from './fixtures/suite-catalog-signing.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

const digest = 'a'.repeat(64)
const verifiedDownload = `curl --fail --location --silent "\${GITHUB_ASSETS_PREFIX}https://github.com/o/r/releases/download/v1/f.tgz" -o f.tgz && echo "${digest}  f.tgz" | sha256sum -c -`
const entry = (overrides: Partial<SuiteCatalogCheckEntry> & Pick<SuiteCatalogCheckEntry, 'id'>, command = 'fixture'): SuiteCatalogCheckEntry => ({
  category: 'dependency',
  items: [{ kind: 'runtime-dependency', commands: [command], prepareCommands: { amd64: verifiedDownload } }],
  ...overrides,
})

it('accepts the bundled catalog together with the online entries and a fully pinned suite fixture', () => {
  const key = createCatalogSigningKey()
  const online = readSuiteCatalog(signCatalog(onlineCatalogEntries, key).bytes, { trustedKeys: [key], platformVersion: '0.1.19' })
  if (online.status !== 'ok') throw new Error('fixture catalog was rejected')
  expect(suiteCatalogViolations([...suiteCatalog, ...online.entries.map(row => row.entry)])).toEqual([])
  expect(suiteCatalogViolations([entry({ id: 'fixture-suite', category: 'suite', dependencies: ['pandoc', 'fixture-tool'] }, 'suite-cli'),
    entry({ id: 'pandoc' }, 'pandoc'), entry({ id: 'fixture-tool' }, 'fixture-tool'),
    { ...entry({ id: 'with-skills' }, 'skill-tool'), skills: [{ type: 'git', url: 'https://github.com/o/r', commit: 'b'.repeat(40) }] }])).toEqual([])
})

it('rejects download hosts outside the five download-source classes', () => {
  const violations = suiteCatalogViolations([entry({ id: 'foreign-host', items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: `curl --fail --location --silent "\${GITHUB_ASSETS_PREFIX}https://example.com/f.tgz" -o f.tgz && echo "${digest}  f.tgz" | sha256sum -c -` } }] })])
  expect(violations).toEqual(['foreign-host: download host example.com is outside the five download-source classes'])
})

it('rejects downloads without a matching sha256 checksum', () => {
  expect(suiteCatalogViolations([entry({ id: 'no-checksum', items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: 'curl --fail --location --silent "${GITHUB_ASSETS_PREFIX}https://github.com/o/r/releases/download/v1/f.tgz" -o f.tgz' } }] })]))
    .toEqual(['no-checksum: 1 downloads but only 0 sha256 checksums'])
  expect(suiteCatalogViolations([entry({ id: 'short-checksum', items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: 'curl --fail --location --silent "\${GITHUB_ASSETS_PREFIX}https://pypi.org/f.whl" -o f.whl && curl --fail --location --silent "\${GITHUB_ASSETS_PREFIX}https://registry.npmjs.org/f.tgz" -o f.tgz && echo "deadbeef  f.whl" | sha256sum -c -' } }] })]))
    .toEqual(['short-checksum: 2 downloads but only 0 sha256 checksums'])
})

it('rejects skill sources that are not Git repositories pinned to a 40-hex commit', () => {
  expect(suiteCatalogViolations([{ ...entry({ id: 'branch-pin' }), skills: [{ type: 'git', url: 'https://github.com/o/r', commit: 'main' }] }]))
    .toEqual(['branch-pin: skill source https://github.com/o/r must pin a Git repository to a 40-hex commit'])
  expect(suiteCatalogViolations([{ ...entry({ id: 'tarball-source' }), skills: [{ type: 'tarball', url: 'https://github.com/o/r', commit: 'c'.repeat(40) }] }]))
    .toEqual(['tarball-source: skill source https://github.com/o/r must pin a Git repository to a 40-hex commit'])
})

it('rejects suites that require catalog dependencies that do not exist', () => {
  expect(suiteCatalogViolations([entry({ id: 'fixture-suite', category: 'suite', dependencies: ['ghost'] }, 'suite-cli'), entry({ id: 'pandoc' }, 'pandoc')]))
    .toEqual(['fixture-suite: requires unknown catalog dependency ghost'])
})

it('rejects command-name conflicts between entries on the same architecture', () => {
  const first = entry({ id: 'first' })
  const second = entry({ id: 'second', items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: verifiedDownload, arm64: verifiedDownload } }] })
  expect(suiteCatalogViolations([first, second])).toEqual(['second: command fixture conflicts with first on amd64'])
  expect(suiteCatalogViolations([first, { ...second, items: [{ kind: 'runtime-dependency', commands: ['other'], prepareCommands: { arm64: verifiedDownload } }] }])).toEqual([])
})

it('checks Git sources on skill items and execution references inside the suite', () => {
  const tool = { kind: 'runtime-dependency', name: 'suite-cli', commands: ['suite-cli'], prepareCommands: { amd64: verifiedDownload } }
  expect(suiteCatalogViolations([{ id: 'item-branch', category: 'suite', items: [tool, { kind: 'skill', source: { type: 'git', url: 'https://github.com/o/r', commit: 'main' }, names: ['one'] }] }]))
    .toEqual(['item-branch: skill source https://github.com/o/r must pin a Git repository to a 40-hex commit'])
  const skill = { kind: 'skill', source: { type: 'git', url: 'https://github.com/o/r', commit: 'b'.repeat(40) }, names: ['one'] }
  expect(suiteCatalogViolations([{ id: 'delegated', category: 'suite', items: [tool, skill, { kind: 'execution', skill: 'one', runtimeDependency: 'suite-cli' }] }])).toEqual([])
  expect(suiteCatalogViolations([{ id: 'delegated', category: 'suite', items: [tool, skill, { kind: 'execution', skill: 'ghost', runtimeDependency: 'other-cli' }] }])).toEqual([
    'delegated: delegated execution belongs to unknown suite skill ghost', 'delegated: delegated execution uses unknown suite runtime dependency other-cli'])
  expect(suiteCatalogViolations([{ id: 'delegated', category: 'suite', items: [tool, { kind: 'execution', skill: 'one', runtimeDependency: 'suite-cli' }, skill] }]))
    .toEqual(['delegated: delegated execution for one must follow its skill item'])
})

it('requires skill catalog dependencies to be declared by the suite', () => {
  const tool = { kind: 'runtime-dependency', name: 'suite-cli', commands: ['suite-cli'], prepareCommands: { amd64: verifiedDownload } }
  const skill = { kind: 'skill', source: { type: 'git', url: 'https://github.com/o/r', commit: 'b'.repeat(40) }, names: ['one'], catalogDependencies: ['ffmpeg'] }
  const ffmpeg = entry({ id: 'ffmpeg' }, 'ffmpeg')
  expect(suiteCatalogViolations([ffmpeg, { id: 'video', category: 'suite', dependencies: ['ffmpeg'], items: [tool, skill] }])).toEqual([])
  expect(suiteCatalogViolations([ffmpeg, { id: 'video', category: 'suite', dependencies: [], items: [tool, skill] }]))
    .toEqual(['video: skills use catalog dependency ffmpeg that the suite does not declare'])
})

it('requires every download line to go through its download-source prefix variable', () => {
  expect(suiteCatalogViolations([entry({ id: 'bypass', items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: `curl --fail --location --silent "https://github.com/o/r/releases/download/v1/f.tgz" -o f.tgz\necho "${digest}  f.tgz" | sha256sum -c -` } }] })])).toContain('bypass: a download bypasses the download-source prefix variable')
  expect(suiteCatalogViolations([entry({ id: 'prefixed', items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: verifiedDownload } }] })])).toEqual([])
  expect(suiteCatalogViolations([entry({ id: 'browser', items: [{ kind: 'runtime-dependency', commands: ['browser'], prepareCommands: { amd64: `curl --fail "\${PLAYWRIGHT_DOWNLOAD_HOST:-https://cdn.playwright.dev}/builds/x.zip" -o x.zip\necho "${digest}  x.zip" | sha256sum -c -` } }] })])).toEqual([])
})

it('rejects registry installs that override the configured download source', () => {
  expect(suiteCatalogViolations([entry({ id: 'registry', items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: 'npm install --prefix "$RD_OUT" --registry https://registry.npmjs.org tool' } }] })]))
    .toContain('registry: a registry install overrides the configured download source')
  expect(suiteCatalogViolations([entry({ id: 'pip', items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: 'pip install -i https://pypi.org/simple tool' } }] })]))
    .toContain('pip: a registry install overrides the configured download source')
})

it('accepts the generated entries of a valid signed online catalog', () => {
  const key = createCatalogSigningKey()
  const result = readSuiteCatalog(signCatalog(onlineCatalogEntries, key).bytes, { trustedKeys: [key], platformVersion: '0.1.19' })
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(suiteCatalogViolations(result.entries.map(row => row.entry))).toEqual([])
})
