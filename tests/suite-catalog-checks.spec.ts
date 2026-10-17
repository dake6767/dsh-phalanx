import { expect, it } from 'vitest'
import { suiteCatalog } from '../src/domain/suite-catalog.js'
import { suiteCatalogViolations, type SuiteCatalogCheckEntry } from '../src/domain/suite-catalog-checks.js'

const digest = 'a'.repeat(64)
const verifiedDownload = `curl --fail --location --silent "\${GITHUB_ASSETS_PREFIX}https://github.com/o/r/releases/download/v1/f.tgz" -o f.tgz && echo "${digest}  f.tgz" | sha256sum -c -`
const entry = (overrides: Partial<SuiteCatalogCheckEntry> & Pick<SuiteCatalogCheckEntry, 'id'>, command = 'fixture'): SuiteCatalogCheckEntry => ({
  category: 'dependency',
  items: [{ kind: 'runtime-dependency', commands: [command], prepareCommands: { amd64: verifiedDownload } }],
  ...overrides,
})

it('accepts the bundled catalog and a fully pinned suite fixture', () => {
  expect(suiteCatalogViolations(suiteCatalog)).toEqual([])
  expect(suiteCatalogViolations([entry({ id: 'fixture-suite', category: 'suite', dependencies: ['pandoc', 'fixture-tool'] }, 'suite-cli'),
    entry({ id: 'pandoc' }, 'pandoc'), entry({ id: 'fixture-tool' }, 'fixture-tool'),
    { ...entry({ id: 'with-skills' }, 'skill-tool'), skills: [{ type: 'git', url: 'https://github.com/o/r', commit: 'b'.repeat(40) }] }])).toEqual([])
})

it('rejects download hosts outside the five download-source classes', () => {
  const violations = suiteCatalogViolations([entry({ id: 'foreign-host', items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: `curl --fail --location --silent https://example.com/f.tgz -o f.tgz && echo "${digest}  f.tgz" | sha256sum -c -` } }] })])
  expect(violations).toEqual(['foreign-host: download host example.com is outside the five download-source classes'])
})

it('rejects downloads without a matching sha256 checksum', () => {
  expect(suiteCatalogViolations([entry({ id: 'no-checksum', items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: 'curl --fail --location --silent "${GITHUB_ASSETS_PREFIX}https://github.com/o/r/releases/download/v1/f.tgz" -o f.tgz' } }] })]))
    .toEqual(['no-checksum: 1 downloads but only 0 sha256 checksums'])
  expect(suiteCatalogViolations([entry({ id: 'short-checksum', items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: 'curl --fail --location --silent https://pypi.org/f.whl -o f.whl && curl --fail --location --silent https://registry.npmjs.org/f.tgz -o f.tgz && echo "deadbeef  f.whl" | sha256sum -c -' } }] })]))
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
