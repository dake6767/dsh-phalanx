import { expect, it } from 'vitest'
import { suitePrepareCheckCommand, suitePrepareCommands } from '../src/domain/suite-prepare-commands.js'
import type { SuiteCatalogRuntimeDependencyItem } from '../src/domain/suite-catalog-document.js'
import { legacyPrepareCommands, onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

const runtimeItem = (id: string): SuiteCatalogRuntimeDependencyItem => {
  const entry = onlineCatalogEntries.find(row => row.id === id)!
  if (entry.kind !== 'dependency' && entry.kind !== 'suite') throw new Error('reserved entry kind')
  return entry.items.find((item): item is SuiteCatalogRuntimeDependencyItem => item.kind === 'runtime-dependency')!
}

it('generates the 0.1.18 preparation commands byte for byte where the 0.1.18 style allows', () => {
  // WeCom (registry install), FFmpeg (raw downloads with checksums) and Chromium (browser archive with entry link)
  // already used the platform's canonical style, so the generated command must match exactly.
  for (const id of ['wecom', 'ffmpeg', 'chromium']) {
    for (const architecture of ['amd64', 'arm64'] as const)
      expect(suitePrepareCommands(runtimeItem(id))[architecture], `${id} ${architecture}`).toBe(legacyPrepareCommands[id]![architecture])
  }
  // The 0.1.18 pandoc definition chained steps with `&&` and no `set -eu`; the platform now emits set -eu + newlines.
  for (const architecture of ['amd64', 'arm64'] as const) {
    expect(suitePrepareCommands(runtimeItem('pandoc'))[architecture]).toBe(`set -eu\n${legacyPrepareCommands.pandoc![architecture].split(' && ').join('\n')}`)
  }
})

it('generates executable readiness checks from data without shell syntax', () => {
  expect(suitePrepareCheckCommand(runtimeItem('pandoc'))).toBe('pandoc --version')
  expect(suitePrepareCheckCommand(runtimeItem('ffmpeg'))).toBe('ffmpeg -hide_banner -version')
  expect(suitePrepareCheckCommand(runtimeItem('chromium'))).toBe('chromium-headless-shell --version')
  expect(suitePrepareCheckCommand(runtimeItem('wecom'))).toBe('wecom-cli --version')
})

it('omits an architecture whose download or entry is not declared', () => {
  const amd64Only: SuiteCatalogRuntimeDependencyItem = {
    kind: 'runtime-dependency',
    name: 'tool',
    paths: ['bin'],
    commands: ['tool'],
    downloads: [
      {
        source: 'github-assets',
        url: 'https://github.com/o/r/releases/download/v1/tool-linux-{arch}',
        sha256: { amd64: 'a'.repeat(64) },
        target: 'bin/tool',
        executable: true,
      },
    ],
  }
  expect(suitePrepareCommands(amd64Only).arm64).toBeUndefined()
  expect(suitePrepareCommands(amd64Only).amd64).toContain('${GITHUB_ASSETS_PREFIX}https://github.com/o/r/releases/download/v1/tool-linux-amd64')
})

it('creates each target directory once and extracts archives before linking entries', () => {
  const item: SuiteCatalogRuntimeDependencyItem = {
    kind: 'runtime-dependency',
    name: 'tool',
    paths: ['bin'],
    commands: ['tool'],
    entry: { amd64: 'lib/tool', arm64: 'lib/tool' },
    downloads: [
      {
        source: 'github-assets',
        url: 'https://github.com/o/r/releases/download/v1/tool.zip',
        sha256: { amd64: 'a'.repeat(64), arm64: 'b'.repeat(64) },
        target: 'tool.zip',
        extract: { format: 'zip', directory: 'lib' },
      },
      { source: 'npm', packages: ['tool@1.0.0'] },
    ],
  }
  const command = suitePrepareCommands(item).amd64!
  expect(command.split('\n')).toEqual([
    'set -eu',
    'curl --fail --location --silent --show-error "${GITHUB_ASSETS_PREFIX}https://github.com/o/r/releases/download/v1/tool.zip" -o tool.zip',
    `echo "${'a'.repeat(64)}  tool.zip" | sha256sum -c -`,
    'mkdir -p lib bin',
    'unzip -q tool.zip -d lib',
    'rm tool.zip',
    'npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund tool@1.0.0',
    'ln -s ../lib/tool bin/tool',
  ])
})

it('routes npm and PyPI through the configured registries instead of hard-coded addresses', () => {
  const command = suitePrepareCommands({
    kind: 'runtime-dependency',
    name: 'tool',
    paths: ['node_modules/.bin'],
    commands: ['tool'],
    downloads: [
      { source: 'npm', packages: ['tool@1.0.0'] },
      { source: 'pypi', packages: ['tool==1.0.0'] },
    ],
  }).amd64!
  expect(command).toContain('npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund tool@1.0.0')
  expect(command).toContain('python3 -m pip install --disable-pip-version-check --no-input --prefix "$RD_OUT" tool==1.0.0')
  expect(command).not.toContain('registry')
  expect(command).not.toContain('http')
})
