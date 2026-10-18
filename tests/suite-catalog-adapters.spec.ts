import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { adapterWrapperSteps, suiteCatalogAdapterWrappers, validateSuiteCatalogAdapters, type ValidatedSuiteCatalogAdapter } from '../src/domain/suite-catalog-adapters.js'
import type { SuiteCatalogAdapterCall, SuiteCatalogRuntimeDependencyItem } from '../src/domain/suite-catalog-document.js'
import { suitePrepareCommands } from '../src/domain/suite-prepare-commands.js'

const runnerItem = (overrides: Partial<SuiteCatalogRuntimeDependencyItem> = {}): SuiteCatalogRuntimeDependencyItem => ({
  kind: 'runtime-dependency', name: 'tools', paths: ['bin'], commands: ['tool'], check: { command: 'tool', args: ['--version'] },
  downloads: [{ source: 'npm', packages: ['tool@1.0.0'] }],
  runner: { command: 'node', path: 'node_modules/tool/dist/tool.mjs' },
  ...overrides,
})
const call = (name: string, params: Readonly<Record<string, unknown>>): SuiteCatalogAdapterCall => ({ name, params })
const validated = (calls: readonly SuiteCatalogAdapterCall[], item = runnerItem()): readonly ValidatedSuiteCatalogAdapter[] => {
  const result = validateSuiteCatalogAdapters(calls, [item])
  if (!result.okay) throw new Error(`${result.code}: ${result.detail}`)
  return result.adapters
}

it('rejects unknown adapter names and invalid parameters without rejecting the entry shape', () => {
  expect(validateSuiteCatalogAdapters([call('secret-adapter', {})], [runnerItem()])).toMatchObject({ okay: false, code: 'unknown-adapter', detail: 'adapters[0]: secret-adapter' })
  const invalid = [
    call('fixed-environment', { item: 'missing', command: 'tool', environment: { A: '1' } }),
    call('fixed-environment', { item: 'tools', command: 'other', environment: { A: '1' } }),
    call('fixed-environment', { item: 'tools', command: 'tool', environment: {} }),
    call('fixed-environment', { item: 'tools', command: 'tool', environment: { 'bad name': '1' } }),
    call('credential-argument', { item: 'tools', command: 'tool', variable: 'lowercase', argument: '--api-key' }),
    call('credential-argument', { item: 'tools', command: 'tool', variable: 'KEY', argument: '--api key' }),
    call('credential-argument', { item: 'tools', command: 'tool', variable: 'KEY', argument: '--api-key', position: 'prepend' }),
    call('refuse', { item: 'tools', command: 'tool' }),
    call('refuse', { item: 'tools', command: 'tool', arguments: ['--bad arg'] }),
    call('refuse', { item: 'tools', command: 'tool', subcommands: ['a b'] }),
    call('refuse', { item: 'tools', command: 'tool', arguments: ['--x'], message: "it's blocked" }),
  ]
  for (const [index, adapter] of invalid.entries()) expect(validateSuiteCatalogAdapters([adapter], [runnerItem()]), String(index)).toMatchObject({ okay: false, code: 'invalid-adapter-params' })
  // A runner is required to place an exec behind the wrapper, and the first PATH directory holds the wrapper.
  const withoutRunner: SuiteCatalogRuntimeDependencyItem = { kind: 'runtime-dependency', name: 'tools', paths: ['bin'], commands: ['tool'],
    downloads: [{ source: 'npm', packages: ['tool@1.0.0'] }] }
  expect(validateSuiteCatalogAdapters([call('fixed-environment', { item: 'tools', command: 'tool', environment: { A: '1' } })], [withoutRunner]))
    .toMatchObject({ okay: false, code: 'invalid-adapter-params', detail: 'fixed-environment: tools declares no runner' })
  expect(validateSuiteCatalogAdapters([call('fixed-environment', { item: 'tools', command: 'tool', environment: { A: '1' } })], [runnerItem({ paths: [] })]))
    .toMatchObject({ okay: false, code: 'invalid-adapter-params' })
  // Duplicate calls for one target are ambiguous.
  expect(validateSuiteCatalogAdapters([call('fixed-environment', { item: 'tools', command: 'tool', environment: { A: '1' } }),
    call('fixed-environment', { item: 'tools', command: 'tool', environment: { B: '2' } })], [runnerItem()])).toMatchObject({ okay: false, code: 'invalid-adapter-params' })
})

it('renders a deterministic wrapper: refusal, credential, environment, then exec', () => {
  const adapters = validated([
    call('fixed-environment', { item: 'tools', command: 'tool', environment: { REGION: 'cn', BRAND: 'feishu' } }),
    call('refuse', { item: 'tools', command: 'tool', arguments: ['--base-url', '--verbose', '--region'], message: 'This option is disabled by the platform.' }),
    call('credential-argument', { item: 'tools', command: 'tool', variable: 'TEAM_KEY', argument: '--api-key' }),
  ])
  const wrappers = suiteCatalogAdapterWrappers(runnerItem(), adapters)
  expect(wrappers).toHaveLength(1)
  expect(wrappers[0]!.path).toBe('bin/tool')
  expect(wrappers[0]!.lines).toEqual([
    '#!/bin/sh',
    'for arg in "$@"; do case "$arg" in --base-url|--base-url=*|--verbose|--verbose=*|--region|--region=*) echo \'This option is disabled by the platform.\' >&2; exit 2;; esac; done',
    'if [ -n "${TEAM_KEY:-}" ]; then set -- "$@" --api-key "$TEAM_KEY"; fi',
    'export REGION=cn',
    'export BRAND=feishu',
    'exec node "$(dirname "$(readlink -f "$0")")/../node_modules/tool/dist/tool.mjs" "$@"',
  ])
  expect(suiteCatalogAdapterWrappers(runnerItem(), adapters)).toEqual(wrappers)
  // The preparation command embeds the wrapper as safe printf data and never as executable catalog strings.
  const command = suitePrepareCommands(runnerItem(), adapters).amd64!
  expect(command).toContain("printf '%s\\n' '#!/bin/sh'")
  expect(command).toContain('chmod +x bin/tool')
  expect(command).not.toContain('TEAM_KEY=team-secret')
})

it('subcommand refusal only inspects the first positional argument', () => {
  const adapters = validated([call('refuse', { item: 'tools', command: 'tool', subcommands: ['skills', 'upgrade'] })])
  const lines = suiteCatalogAdapterWrappers(runnerItem(), adapters)[0]!.lines
  expect(lines[1]).toBe('for arg in "$@"; do case "$arg" in -*) ;; skills|upgrade) echo \'This option is disabled by the platform.\' >&2; exit 2;; *) break;; esac; done')
})

it('executes fixed environment and refusal behavior without shell interpolation of catalog data', async () => {
  const adapters = validated([
    call('fixed-environment', { item: 'tools', command: 'tool', environment: { SKIP_UPDATE: '1', LITERAL: '$(touch PWNED) `touch PWNED2`' } }),
    call('refuse', { item: 'tools', command: 'tool', arguments: ['--base-url'] }),
  ])
  const root = await mkdtemp(join(tmpdir(), 'adapter-wrapper-'))
  try {
    for (const file of ['bin', 'node_modules/tool/dist', 'lib']) await import('node:fs/promises').then(fs => fs.mkdir(join(root, file), { recursive: true }))
    const wrapper = suiteCatalogAdapterWrappers(runnerItem(), adapters)[0]!
    await writeFile(join(root, wrapper.path), `${wrapper.lines.join('\n')}\n`, { mode: 0o755 })
    await chmod(join(root, wrapper.path), 0o755)
    await writeFile(join(root, 'node_modules/tool/dist/tool.mjs'), "console.log(JSON.stringify({ argv: process.argv.slice(2), skip: process.env.SKIP_UPDATE ?? null, literal: process.env.LITERAL ?? null }))\n")
    const allowed = spawnSync(join(root, 'bin/tool'), ['image'], { encoding: 'utf8' })
    expect(allowed.status, allowed.stderr).toBe(0)
    expect(JSON.parse(allowed.stdout)).toEqual({ argv: ['image'], skip: '1', literal: '$(touch PWNED) `touch PWNED2`' })
    expect(await readFile(join(root, 'PWNED')).catch(() => undefined)).toBeUndefined()
    const refused = spawnSync(join(root, 'bin/tool'), ['--base-url', 'https://evil'], { encoding: 'utf8' })
    expect(refused.status).toBe(2); expect(refused.stdout).toBe(''); expect(refused.stderr).toContain('This option is disabled by the platform.')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('supports an artifact path runner with fixed arguments and a PATH command runner', () => {
  expect(adapterWrapperSteps(runnerItem({ runner: { path: 'lib/tool', args: ['--first'] } }), validated([call('fixed-environment', { item: 'tools', command: 'tool', environment: { A: '1' } })])))
    .toEqual([`printf '%s\\n' '#!/bin/sh' 'export A=1' 'exec "$(dirname "$(readlink -f "$0")")/../lib/tool" --first "$@"' > bin/tool`, 'chmod +x bin/tool'])
  expect(validated([call('fixed-environment', { item: 'tools', command: 'tool', environment: { A: '1' } })], runnerItem({ runner: { command: 'tool-real' } })))
    .toMatchObject([{ kind: 'fixed-environment' }])
  expect(suiteCatalogAdapterWrappers(runnerItem({ runner: { command: 'tool-real' } }), validated([call('fixed-environment', { item: 'tools', command: 'tool', environment: { A: '1' } })]))[0]!.lines.at(-1))
    .toBe('exec tool-real "$@"')
})
