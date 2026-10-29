import { expect, it } from 'vitest'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
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

it('accepts the online entries and a fully pinned suite fixture', () => {
  const key = createCatalogSigningKey()
  const online = readSuiteCatalog(signCatalog(onlineCatalogEntries, key).bytes, { trustedKeys: [key], platformVersion: '0.1.19' })
  if (online.status !== 'ok') throw new Error('fixture catalog was rejected')
  expect(suiteCatalogViolations(online.entries.map(row => row.entry))).toEqual([])
  expect(
    suiteCatalogViolations([
      entry({ id: 'fixture-suite', category: 'suite', dependencies: ['pandoc', 'fixture-tool'] }, 'suite-cli'),
      entry({ id: 'pandoc' }, 'pandoc'),
      entry({ id: 'fixture-tool' }, 'fixture-tool'),
      { ...entry({ id: 'with-skills' }, 'skill-tool'), skills: [{ type: 'git', url: 'https://github.com/o/r', commit: 'b'.repeat(40) }] },
    ]),
  ).toEqual([])
})

it('rejects download hosts outside the five download-source classes', () => {
  const violations = suiteCatalogViolations([
    entry({
      id: 'foreign-host',
      items: [
        {
          kind: 'runtime-dependency',
          commands: ['fixture'],
          prepareCommands: {
            amd64: `curl --fail --location --silent "\${GITHUB_ASSETS_PREFIX}https://example.com/f.tgz" -o f.tgz && echo "${digest}  f.tgz" | sha256sum -c -`,
          },
        },
      ],
    }),
  ])
  expect(violations).toEqual(['foreign-host: download host example.com is outside the five download-source classes'])
})

it('rejects preparation commands beyond the runtime dependency definition budget', () => {
  const resource = (length: number) =>
    entry({ id: 'static-resources', items: [{ kind: 'runtime-dependency', type: 'resource', commands: [], prepareCommands: { amd64: 'x'.repeat(length) } }] })
  expect(suiteCatalogViolations([resource(128 * 1024)])).toEqual([])
  expect(suiteCatalogViolations([resource(128 * 1024 + 1)])).toEqual(['static-resources: preparation command exceeds the 128 KiB runtime dependency limit'])
})

it('rejects downloads without a matching sha256 checksum', () => {
  expect(
    suiteCatalogViolations([
      entry({
        id: 'no-checksum',
        items: [
          {
            kind: 'runtime-dependency',
            commands: ['fixture'],
            prepareCommands: { amd64: 'curl --fail --location --silent "${GITHUB_ASSETS_PREFIX}https://github.com/o/r/releases/download/v1/f.tgz" -o f.tgz' },
          },
        ],
      }),
    ]),
  ).toEqual(['no-checksum: 1 downloads but only 0 sha256 checksums'])
  expect(
    suiteCatalogViolations([
      entry({
        id: 'short-checksum',
        items: [
          {
            kind: 'runtime-dependency',
            commands: ['fixture'],
            prepareCommands: {
              amd64:
                'curl --fail --location --silent "${GITHUB_ASSETS_PREFIX}https://pypi.org/f.whl" -o f.whl && curl --fail --location --silent "${GITHUB_ASSETS_PREFIX}https://registry.npmjs.org/f.tgz" -o f.tgz && echo "deadbeef  f.whl" | sha256sum -c -',
            },
          },
        ],
      }),
    ]),
  ).toEqual(['short-checksum: 2 downloads but only 0 sha256 checksums'])
})

it('rejects skill sources that are not Git repositories pinned to a 40-hex commit', () => {
  expect(suiteCatalogViolations([{ ...entry({ id: 'branch-pin' }), skills: [{ type: 'git', url: 'https://github.com/o/r', commit: 'main' }] }])).toEqual([
    'branch-pin: skill source https://github.com/o/r must pin a Git repository to a 40-hex commit',
  ])
  expect(
    suiteCatalogViolations([{ ...entry({ id: 'tarball-source' }), skills: [{ type: 'tarball', url: 'https://github.com/o/r', commit: 'c'.repeat(40) }] }]),
  ).toEqual(['tarball-source: skill source https://github.com/o/r must pin a Git repository to a 40-hex commit'])
  expect(suiteCatalogViolations([{ ...entry({ id: 'plain-http' }), skills: [{ type: 'git', url: 'http://github.com/o/r', commit: 'c'.repeat(40) }] }])).toEqual(
    ['plain-http: skill source http://github.com/o/r must pin a Git repository to a 40-hex commit'],
  )
  // Only github.com is an accepted catalog skill source.
  expect(
    suiteCatalogViolations([{ ...entry({ id: 'foreign-host' }), skills: [{ type: 'git', url: 'https://git.example/o/r', commit: 'c'.repeat(40) }] }]),
  ).toEqual(['foreign-host: skill source https://git.example/o/r must pin a Git repository to a 40-hex commit'])
})

it('rejects suites that require catalog dependencies that do not exist', () => {
  expect(
    suiteCatalogViolations([entry({ id: 'fixture-suite', category: 'suite', dependencies: ['ghost'] }, 'suite-cli'), entry({ id: 'pandoc' }, 'pandoc')]),
  ).toEqual(['fixture-suite: requires unknown catalog dependency ghost'])
})

it('rejects command-name conflicts between entries on the same architecture', () => {
  const first = entry({ id: 'first' })
  const second = entry({
    id: 'second',
    items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: verifiedDownload, arm64: verifiedDownload } }],
  })
  expect(suiteCatalogViolations([first, second])).toEqual(['second: command fixture conflicts with first on amd64'])
  expect(
    suiteCatalogViolations([first, { ...second, items: [{ kind: 'runtime-dependency', commands: ['other'], prepareCommands: { arm64: verifiedDownload } }] }]),
  ).toEqual([])
})

it('checks Git sources on skill items and execution references inside the suite', () => {
  const tool = { kind: 'runtime-dependency', name: 'suite-cli', commands: ['suite-cli'], prepareCommands: { amd64: verifiedDownload } }
  expect(
    suiteCatalogViolations([
      {
        id: 'item-branch',
        category: 'suite',
        items: [tool, { kind: 'skill', source: { type: 'git', url: 'https://github.com/o/r', commit: 'main' }, names: ['one'] }],
      },
    ]),
  ).toEqual(['item-branch: skill source https://github.com/o/r must pin a Git repository to a 40-hex commit'])
  const skill = { kind: 'skill', source: { type: 'git', url: 'https://github.com/o/r', commit: 'b'.repeat(40) }, names: ['one'] }
  expect(
    suiteCatalogViolations([{ id: 'delegated', category: 'suite', items: [tool, skill, { kind: 'execution', skill: 'one', runtimeDependency: 'suite-cli' }] }]),
  ).toEqual([])
  expect(
    suiteCatalogViolations([
      { id: 'delegated', category: 'suite', items: [tool, skill, { kind: 'execution', skill: 'ghost', runtimeDependency: 'other-cli' }] },
    ]),
  ).toEqual([
    'delegated: delegated execution belongs to unknown suite skill ghost',
    'delegated: delegated execution uses unknown suite runtime dependency other-cli',
  ])
  expect(
    suiteCatalogViolations([{ id: 'delegated', category: 'suite', items: [tool, { kind: 'execution', skill: 'one', runtimeDependency: 'suite-cli' }, skill] }]),
  ).toEqual(['delegated: delegated execution for one must follow its skill item'])
})

it('requires skill catalog dependencies to be declared by the suite', () => {
  const tool = { kind: 'runtime-dependency', name: 'suite-cli', commands: ['suite-cli'], prepareCommands: { amd64: verifiedDownload } }
  const skill = {
    kind: 'skill',
    source: { type: 'git', url: 'https://github.com/o/r', commit: 'b'.repeat(40) },
    names: ['one'],
    catalogDependencies: ['ffmpeg'],
  }
  const ffmpeg = entry({ id: 'ffmpeg' }, 'ffmpeg')
  expect(suiteCatalogViolations([ffmpeg, { id: 'video', category: 'suite', dependencies: ['ffmpeg'], items: [tool, skill] }])).toEqual([])
  expect(suiteCatalogViolations([ffmpeg, { id: 'video', category: 'suite', dependencies: [], items: [tool, skill] }])).toEqual([
    'video: skills use catalog dependency ffmpeg that the suite does not declare',
  ])
})

it('requires every download line to go through its download-source prefix variable', () => {
  expect(
    suiteCatalogViolations([
      entry({
        id: 'bypass',
        items: [
          {
            kind: 'runtime-dependency',
            commands: ['fixture'],
            prepareCommands: {
              amd64: `curl --fail --location --silent "https://github.com/o/r/releases/download/v1/f.tgz" -o f.tgz\necho "${digest}  f.tgz" | sha256sum -c -`,
            },
          },
        ],
      }),
    ]),
  ).toContain('bypass: a download bypasses the download-source prefix variable')
  expect(
    suiteCatalogViolations([
      entry({ id: 'prefixed', items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: verifiedDownload } }] }),
    ]),
  ).toEqual([])
  expect(
    suiteCatalogViolations([
      entry({
        id: 'browser',
        items: [
          {
            kind: 'runtime-dependency',
            commands: ['browser'],
            prepareCommands: {
              amd64: `curl --fail "\${PLAYWRIGHT_DOWNLOAD_HOST:-https://cdn.playwright.dev}/builds/x.zip" -o x.zip\necho "${digest}  x.zip" | sha256sum -c -`,
            },
          },
        ],
      }),
    ]),
  ).toEqual([])
})

it('rejects registry installs that override the configured download source', () => {
  expect(
    suiteCatalogViolations([
      entry({
        id: 'registry',
        items: [
          {
            kind: 'runtime-dependency',
            commands: ['fixture'],
            prepareCommands: { amd64: 'npm install --prefix "$RD_OUT" --registry https://registry.npmjs.org tool' },
          },
        ],
      }),
    ]),
  ).toContain('registry: a registry install overrides the configured download source')
  expect(
    suiteCatalogViolations([
      entry({
        id: 'pip',
        items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: 'pip install -i https://pypi.org/simple tool' } }],
      }),
    ]),
  ).toContain('pip: a registry install overrides the configured download source')
})

it('accepts the generated entries of a valid signed online catalog', () => {
  const key = createCatalogSigningKey()
  const result = readSuiteCatalog(signCatalog(onlineCatalogEntries, key).bytes, { trustedKeys: [key], platformVersion: '0.1.19' })
  expect(result.status).toBe('ok')
  if (result.status !== 'ok') return
  expect(suiteCatalogViolations(result.entries.map(row => row.entry))).toEqual([])
})

it('requires exact versions for registry packages, which carry no file checksum', () => {
  const npm = (packages: string) =>
    entry({
      id: 'registry-pin',
      items: [
        {
          kind: 'runtime-dependency',
          commands: ['fixture'],
          prepareCommands: { amd64: `npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund ${packages}` },
        },
      ],
    })
  expect(suiteCatalogViolations([npm('tool@1.2.3')])).toEqual([])
  expect(suiteCatalogViolations([npm('@scope/tool@1.2.3')])).toEqual([])
  expect(suiteCatalogViolations([npm('tool@^1.2.3')])).toContain('registry-pin: npm package tool@^1.2.3 must pin an exact version')
  expect(suiteCatalogViolations([npm('tool')])).toContain('registry-pin: npm package tool must pin an exact version')
  expect(suiteCatalogViolations([npm('tool@latest')])).toContain('registry-pin: npm package tool@latest must pin an exact version')
  const pip = (packages: string) =>
    entry({
      id: 'pip-pin',
      items: [
        {
          kind: 'runtime-dependency',
          commands: ['fixture'],
          prepareCommands: { amd64: `python3 -m pip install --disable-pip-version-check --no-input --prefix "$RD_OUT" ${packages}` },
        },
      ],
    })
  expect(suiteCatalogViolations([pip('tool==1.2.3')])).toEqual([])
  expect(suiteCatalogViolations([pip('tool>=1.2.3')])).toContain('pip-pin: PyPI package tool>=1.2.3 must pin an exact version')
  expect(suiteCatalogViolations([pip('tool')])).toContain('pip-pin: PyPI package tool must pin an exact version')
})

it('accepts exact PEP 440 two-part pins and rejects normalized Python package conflicts between obtainable entries', () => {
  const library = (id: string, packages: readonly string[]): SuiteCatalogCheckEntry => ({
    id,
    category: 'dependency',
    items: [
      {
        kind: 'runtime-dependency',
        type: 'python-library',
        packages,
        commands: ['python3'],
        prepareCommands: { amd64: 'prepared-venv', arm64: 'prepared-venv' },
      },
    ],
  })
  expect(suiteCatalogViolations([library('one', ['PyMuPDF==2.0']), library('two', ['pymupdf==2.0.0', 'six==1.17.0'])])).toEqual([])
  expect(suiteCatalogViolations([library('one', ['Some_Package==1.0']), library('two', ['some-package==2.0'])])).toContain(
    'two: Python package some-package conflicts with one on amd64',
  )
  expect(suiteCatalogViolations([library('one', ['six>=1.0'])])).toContain('one: Python libraries must list exact, non-conflicting PyPI versions')
  expect(
    suiteCatalogViolations([
      entry({
        id: 'two-part',
        items: [{ kind: 'runtime-dependency', commands: ['fixture'], prepareCommands: { amd64: 'python3 -m pip install PyMuPDF==2.0' } }],
      }),
    ]),
  ).toEqual([])
})

it('does not treat a locked curl-cffi package argument as a curl download command', () => {
  expect(
    suiteCatalogViolations([
      entry({
        id: 'python-images',
        items: [
          {
            kind: 'runtime-dependency',
            type: 'python-library',
            name: 'python-images',
            packages: ['curl-cffi==0.16.3'],
            commands: ['python3'],
            prepareCommands: { amd64: '"$RD_OUT/venv/bin/python3" -m pip install --only-binary=:all: --no-deps \'curl-cffi==0.16.3\'' },
          },
        ],
      }),
    ]),
  ).toEqual([])
})
