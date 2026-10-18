import { spawnSync } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { adapterWrapperSteps, credentialTokenHelper, suiteCatalogAdapterWrappers, validateSuiteCatalogAdapters, type ValidatedSuiteCatalogAdapter } from '../src/domain/suite-catalog-adapters.js'
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
    call('normalize-arguments', { item: 'tools', command: 'tool', replacements: [] }),
    call('normalize-arguments', { item: 'tools', command: 'tool', replacements: [{ from: '--yes', to: '--non-interactive' }, { from: '--yes', to: '--force' }] }),
    call('normalize-arguments', { item: 'tools', command: 'tool', replacements: [{ from: '--yes', to: '--yes' }] }),
    call('normalize-arguments', { item: 'tools', command: 'tool', replacements: [{ from: '$(id)', to: '--yes' }] }),
    call('normalize-arguments', { item: 'tools', command: 'tool', replacements: [{ from: '--yes', to: '--non-interactive' }], valueArguments: ['--yes'] }),
    call('normalize-arguments', { item: 'tools', command: 'tool', replacements: [{ from: '--yes', to: '--non-interactive' }], valueArguments: ['--bad arg'] }),
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
    'for arg in "$@"; do case "$arg" in --) break;; --base-url|--base-url=*|--verbose|--verbose=*|--region|--region=*) printf \'%s\\n\' \'This option is disabled by the platform.\' >&2; exit 2;; esac; done',
    'if [ -n "${TEAM_KEY:-}" ]; then',
    '  first=0; position=0',
    '  for arg in "$@"; do position=$((position + 1)); [ "$arg" = "--" ] && { first=$position; break; }; done',
    '  count=$#; seen=0',
    '  while [ "$count" -gt 0 ]; do',
    '    arg=$1; shift; count=$((count - 1)); seen=$((seen + 1))',
    '    if [ "$seen" -eq "$first" ]; then set -- "$@" --api-key "$TEAM_KEY"; fi',
    '    set -- "$@" "$arg"',
    '  done',
    '  if [ "$first" -eq 0 ]; then set -- "$@" --api-key "$TEAM_KEY"; fi',
    'fi',
    'export REGION=cn',
    'export BRAND=feishu',
    'exec node "$(dirname "$(readlink -f "$0")")/../node_modules/tool/dist/tool.mjs" "$@"',
  ])
  // The renderer is pure: an independently constructed but equivalent item renders the same bytes.
  const independentItem: SuiteCatalogRuntimeDependencyItem = JSON.parse(JSON.stringify(runnerItem())) as SuiteCatalogRuntimeDependencyItem
  expect(suiteCatalogAdapterWrappers(independentItem, adapters)).toEqual(wrappers)
  const equivalent = validated([
    call('fixed-environment', { item: 'tools', command: 'tool', environment: { REGION: 'cn', BRAND: 'feishu' } }),
    call('refuse', { item: 'tools', command: 'tool', arguments: ['--base-url', '--verbose', '--region'], message: 'This option is disabled by the platform.' }),
    call('credential-argument', { item: 'tools', command: 'tool', variable: 'TEAM_KEY', argument: '--api-key' }),
  ])
  expect(suiteCatalogAdapterWrappers(independentItem, equivalent)).toEqual(wrappers)
  // The preparation command embeds the wrapper as safe printf data and names the credential variable only.
  const command = suitePrepareCommands(runnerItem(), adapters).amd64!
  expect(command).toContain("printf '%s\\n' '#!/bin/sh'")
  expect(command).toContain('chmod +x bin/tool')
  expect(command).toContain('TEAM_KEY')
  expect(command).toContain('"$TEAM_KEY"')
})

it('subcommand refusal only inspects the first positional argument', () => {
  const adapters = validated([call('refuse', { item: 'tools', command: 'tool', subcommands: ['skills', 'upgrade'] })])
  const lines = suiteCatalogAdapterWrappers(runnerItem(), adapters)[0]!.lines
  expect(lines).toEqual(['#!/bin/sh', 'skip=0', 'for arg in "$@"; do', '  if [ "$skip" = 1 ]; then skip=0; continue; fi', '  case "$arg" in',
    '    --) break ;;', '    -*) ;;', "    skills|upgrade) printf '%s\\n' 'This option is disabled by the platform.' >&2; exit 2 ;;", '    *) break ;;', '  esac', 'done',
    'exec node "$(dirname "$(readlink -f "$0")")/../node_modules/tool/dist/tool.mjs" "$@"'])
})

it('refuses a later subcommand across value-taking flags and keeps messages starting with -n', async () => {
  const adapters = validated([call('refuse', { item: 'tools', command: 'tool', subcommands: ['update'], valueArguments: ['--output', '--message'], message: '-n disabled' })])
  const root = await mkdtemp(join(tmpdir(), 'adapter-subcommand-'))
  try {
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'bin'), { recursive: true }))
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'node_modules/tool/dist'), { recursive: true }))
    await writeFile(join(root, 'node_modules/tool/dist/tool.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
    const wrapper = suiteCatalogAdapterWrappers(runnerItem(), adapters)[0]!
    await writeFile(join(root, wrapper.path), `${wrapper.lines.join('\n')}\n`, { mode: 0o755 }); await chmod(join(root, wrapper.path), 0o755)
    const command = join(root, 'bin/tool')
    // The value of --output is skipped, so the next token is still the first positional subcommand.
    const refused = spawnSync(command, ['--output', 'x', 'update'], { encoding: 'utf8' })
    expect(refused.status).toBe(2); expect(refused.stdout).toBe(''); expect(refused.stderr).toBe('-n disabled\n')
    // A value that happens to equal the subcommand is not refused.
    const allowed = spawnSync(command, ['--output', 'update'], { encoding: 'utf8' })
    expect(allowed.status, allowed.stderr).toBe(0)
    // Everything after `--` is positional data, not a subcommand.
    const afterDash = spawnSync(command, ['--', 'update'], { encoding: 'utf8' })
    expect(afterDash.status, afterDash.stderr).toBe(0)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('inserts the credential before the first -- so it stays an option', async () => {
  const adapters = validated([call('credential-argument', { item: 'tools', command: 'tool', variable: 'TEAM_KEY', argument: '--api-key' })])
  const root = await mkdtemp(join(tmpdir(), 'adapter-credential-'))
  try {
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'bin'), { recursive: true }))
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'node_modules/tool/dist'), { recursive: true }))
    await writeFile(join(root, 'node_modules/tool/dist/tool.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
    const wrapper = suiteCatalogAdapterWrappers(runnerItem(), adapters)[0]!
    const script = `${wrapper.lines.join('\n')}\n`
    await writeFile(join(root, wrapper.path), script, { mode: 0o755 }); await chmod(join(root, wrapper.path), 0o755)
    const command = join(root, 'bin/tool')
    const env = { ...process.env, TEAM_KEY: 'team-secret-fixture-value' }
    expect(JSON.parse(spawnSync(command, ['docs', 'list'], { encoding: 'utf8', env }).stdout)).toEqual(['docs', 'list', '--api-key', 'team-secret-fixture-value'])
    expect(JSON.parse(spawnSync(command, ['docs', '--', 'list'], { encoding: 'utf8', env }).stdout)).toEqual(['docs', '--api-key', 'team-secret-fixture-value', '--', 'list'])
    expect(JSON.parse(spawnSync(command, ['a', '--', 'b', '--', 'c'], { encoding: 'utf8', env }).stdout)).toEqual(['a', '--api-key', 'team-secret-fixture-value', '--', 'b', '--', 'c'])
    // Without the environment variable nothing is appended.
    expect(JSON.parse(spawnSync(command, ['docs', '--', 'list'], { encoding: 'utf8' }).stdout)).toEqual(['docs', '--', 'list'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects wrapper paths that collide with a download, the runner or an entry target', () => {
  const adapter = call('fixed-environment', { item: 'tools', command: 'tool', environment: { A: '1' } })
  const downloadCollision = runnerItem({ downloads: [{ source: 'github-assets', url: 'https://github.com/o/r/releases/download/v1/tool-{arch}',
    sha256: { amd64: 'a'.repeat(64), arm64: 'b'.repeat(64) }, target: 'bin/tool', executable: true }] })
  expect(validateSuiteCatalogAdapters([adapter], [downloadCollision]))
    .toMatchObject({ okay: false, code: 'invalid-adapter-params', detail: 'fixed-environment: wrapper path bin/tool collides with a download target' })
  expect(validateSuiteCatalogAdapters([adapter], [runnerItem({ runner: { path: 'bin/tool' } })]))
    .toMatchObject({ okay: false, code: 'invalid-adapter-params', detail: 'fixed-environment: wrapper path bin/tool collides with the runner path' })
  expect(validateSuiteCatalogAdapters([adapter], [runnerItem({ entry: 'bin/tool' })]))
    .toMatchObject({ okay: false, code: 'invalid-adapter-params', detail: 'fixed-environment: wrapper path bin/tool collides with the entry path' })
})

it('stops refusal scanning after a standalone -- for both arguments and subcommands', async () => {
  const adapters = validated([call('refuse', { item: 'tools', command: 'tool', arguments: ['--base-url'], subcommands: ['update'], valueArguments: ['--output'], message: 'disabled' })])
  const root = await mkdtemp(join(tmpdir(), 'adapter-dashdash-'))
  try {
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'bin'), { recursive: true }))
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'node_modules/tool/dist'), { recursive: true }))
    await writeFile(join(root, 'node_modules/tool/dist/tool.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)))\n')
    const wrapper = suiteCatalogAdapterWrappers(runnerItem(), adapters)[0]!
    await writeFile(join(root, wrapper.path), `${wrapper.lines.join('\n')}\n`, { mode: 0o755 }); await chmod(join(root, wrapper.path), 0o755)
    const command = join(root, 'bin/tool')
    // Both scans stop at the separator, so these are positional data rather than refused flags/subcommands.
    for (const args of [['--', '--base-url'], ['--', 'update']]) {
      const result = spawnSync(command, args, { encoding: 'utf8' })
      expect(result.status, args.join(' ')).toBe(0)
    }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not link a checksummed entry under a wrapper command and resolves the root from nested path directories', async () => {
  const item = runnerItem({ entry: 'lib/tool', runner: { path: 'lib/tool' }, downloads: [{ source: 'github-assets',
    url: 'https://github.com/o/r/releases/download/v1/tool-{arch}', sha256: { amd64: 'a'.repeat(64), arm64: 'b'.repeat(64) }, target: 'lib/tool', executable: true }] })
  const adapters = validated([call('fixed-environment', { item: 'tools', command: 'tool', environment: { A: '1' } })], item)
  const preparation = suitePrepareCommands(item, adapters).amd64!
  expect(preparation).not.toContain('ln -s')
  expect(preparation).toContain('printf \'%s\\n\'')
  // The wrapper resolves the preparation root from bin/ and execs lib/tool directly, not through bin/tool.
  expect(suiteCatalogAdapterWrappers(item, adapters)[0]!.lines.at(-1)).toBe('exec "$(dirname "$(readlink -f "$0")")/../lib/tool" "$@"')
  const root = await mkdtemp(join(tmpdir(), 'adapter-entry-'))
  try {
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'bin'), { recursive: true }))
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'lib'), { recursive: true }))
    const artifact = Buffer.from('#!/bin/sh\nprintf \'artifact-bytes\\n\'\n')
    await writeFile(join(root, 'lib/tool'), artifact, { mode: 0o755 }); await chmod(join(root, 'lib/tool'), 0o755)
    const wrapper = suiteCatalogAdapterWrappers(item, adapters)[0]!
    await writeFile(join(root, wrapper.path), `${wrapper.lines.join('\n')}\n`, { mode: 0o755 }); await chmod(join(root, wrapper.path), 0o755)
    // The PATH command is the wrapper, and running it leaves the checksummed artifact byte-identical.
    expect(await readFile(join(root, 'bin/tool'), 'utf8')).toContain('#!/bin/sh')
    const before = await readFile(join(root, 'lib/tool'))
    const run = spawnSync(join(root, 'bin/tool'), ['--version'], { encoding: 'utf8', env: { ...process.env, PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}` } })
    expect(run.status, run.stderr).toBe(0); expect(run.stdout).toBe('artifact-bytes\n')
    expect(await readFile(join(root, 'lib/tool'))).toEqual(before)
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('resolves the preparation root for a nested path directory', () => {
  const item = runnerItem({ paths: ['tools/bin'], runner: { path: 'lib/tool' } })
  const adapters = validated([call('fixed-environment', { item: 'tools', command: 'tool', environment: { A: '1' } })], item)
  const wrapper = suiteCatalogAdapterWrappers(item, adapters)[0]!
  expect(wrapper.path).toBe('tools/bin/tool')
  expect(wrapper.lines.at(-1)).toBe('exec "$(dirname "$(readlink -f "$0")")/../../lib/tool" "$@"')
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

it('normalizes only standalone flag tokens, preserving order, inline values and everything after --', async () => {
  const adapters = validated([call('normalize-arguments', {
    item: 'tools', command: 'tool',
    replacements: [{ from: '--yes', to: '--non-interactive' }],
    valueArguments: ['--prompt', '--message'],
  })])
  const lines = suiteCatalogAdapterWrappers(runnerItem(), adapters)[0]!.lines
  expect(lines.slice(1, 4)).toEqual(['count=$#', 'normalizing=1', 'expect_value=0'])
  expect(lines).toContain('      --) normalizing=0 ;;')
  expect(lines).toContain('      --prompt|--message) expect_value=1 ;;')
  expect(lines).toContain('      --yes) arg=--non-interactive ;;')
  // Same catalog input always renders the same wrapper.
  expect(suiteCatalogAdapterWrappers(runnerItem(), adapters)).toEqual(suiteCatalogAdapterWrappers(runnerItem(), adapters))

  const root = await mkdtemp(join(tmpdir(), 'adapter-normalize-')); 
  try {
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'bin'), { recursive: true }))
    await import('node:fs/promises').then(fs => fs.mkdir(join(root, 'node_modules/tool/dist'), { recursive: true }))
    await writeFile(join(root, 'bin/tool'), `${lines.join('\n')}\n`, { mode: 0o755 }); await chmod(join(root, 'bin/tool'), 0o755)
    await writeFile(join(root, 'node_modules/tool/dist/tool.mjs'), "console.log(JSON.stringify(process.argv.slice(2)))\n")
    const result = spawnSync(join(root, 'bin/tool'), ['image', '--yes', '--prompt', '--yes', '--yes=false', '--yes=yes', '--', '--yes'], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(['image', '--non-interactive', '--prompt', '--yes', '--yes=false', '--yes=yes', '--', '--yes'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('keeps refusal on the original arguments and appends the credential after normalization', () => {
  const adapters = validated([
    call('refuse', { item: 'tools', command: 'tool', arguments: ['--base-url'] }),
    call('normalize-arguments', { item: 'tools', command: 'tool', replacements: [{ from: '--yes', to: '--non-interactive' }] }),
    call('credential-argument', { item: 'tools', command: 'tool', variable: 'TEAM_KEY', argument: '--api-key' }),
  ])
  const lines = suiteCatalogAdapterWrappers(runnerItem(), adapters)[0]!.lines
  const refusal = lines.findIndex(line => line.startsWith('for arg in "$@"; do case'))
  const normalization = lines.indexOf('count=$#')
  const credential = lines.findIndex(line => line.startsWith('if [ -n "${TEAM_KEY:-}" ]'))
  expect(refusal).toBeGreaterThanOrEqual(0); expect(normalization).toBeGreaterThan(refusal); expect(credential).toBeGreaterThan(normalization)
})

it('validates the token, npx and shared-dependency adapters against the entry declarations', () => {
  const context = { serviceAddresses: ['https://open.example.test'], dependencies: ['chromium'], executionVariables: ['APP_ID', 'APP_SECRET'] }
  const token = (overrides: Record<string, unknown> = {}) => call('credential-token', {
    item: 'tools', command: 'tool',
    request: { url: 'https://open.example.test/oauth/token', method: 'POST', headers: { 'content-type': 'application/json' },
      body: { app_id: { env: 'APP_ID' }, app_secret: { env: 'APP_SECRET' } } },
    responseTokenPath: 'data.access_token', environment: 'SESSION_TOKEN', message: 'Credentials could not be used.', ...overrides,
  })
  const invalid = (adapter: SuiteCatalogAdapterCall) => expect(validateSuiteCatalogAdapters([adapter], [runnerItem()], context)).toMatchObject({ okay: false, code: 'invalid-adapter-params' })
  expect(validateSuiteCatalogAdapters([token()], [runnerItem()], context)).toMatchObject({ okay: true })
  // The request must target a declared service address; a declaration is an origin plus optional base-path prefix.
  invalid(token({ request: { url: 'https://evil.example.test/oauth/token', body: { app_id: { env: 'APP_ID' } } } }))
  expect(validateSuiteCatalogAdapters([token({ request: { url: 'https://open.example.test/other/token', body: { app_id: { env: 'APP_ID' } } } })], [runnerItem()], context))
    .toMatchObject({ okay: true })
  const narrowContext = { serviceAddresses: ['https://open.example.test/oauth'], dependencies: ['chromium'], executionVariables: ['APP_ID', 'APP_SECRET'] }
  expect(validateSuiteCatalogAdapters([token({ request: { url: 'https://open.example.test/other/token', body: { app_id: { env: 'APP_ID' } } } })], [runnerItem()], narrowContext))
    .toMatchObject({ okay: false, code: 'invalid-adapter-params' })
  invalid(token({ request: { url: 'http://open.example.test/oauth/token', body: { app_id: { env: 'APP_ID' } } } })) // scheme differs
  invalid(token({ responseTokenPath: 'data..token' }))
  invalid(token({ environment: 'lowercase' }))
  invalid(token({ request: { url: 'https://open.example.test/oauth/token', method: 'GET', body: { app_id: { env: 'APP_ID' } } } }))
  invalid(token({ request: { url: 'https://open.example.test/oauth/token', body: { app_id: { env: 'lowercase' } } } }))
  invalid(token({ request: { url: 'https://open.example.test/oauth/token', body: {} } }))
  // Credential sources must be declared execution variables of the suite, not arbitrary environment names.
  invalid(token({ request: { url: 'https://open.example.test/oauth/token', body: { app_id: { env: 'APP_ID' }, secret: { env: 'OTHER_SECRET' } } } }))
  invalid(token({ message: "it's invalid" }))

  const npx = (overrides: Record<string, unknown> = {}) => call('intercept-npx', { item: 'tools', command: 'npx', packages: ['hyperframes'], route: 'tool', ...overrides })
  // A route command must exist and the intercepted command must be npx.
  invalid(npx({ route: 'missing' })); invalid(npx({ command: 'tool' })); invalid(npx({ packages: ['bad name'] })); invalid(npx({ packages: [] }))
  expect(validateSuiteCatalogAdapters([npx()], [runnerItem({ commands: ['tool', 'npx'] })], context)).toMatchObject({ okay: true })

  // Interception must never hide a checksummed entry command.
  const entryNpx = runnerItem({ entry: 'lib/npx', commands: ['npx', 'tool'], runner: { command: 'node', path: 'lib/npx' } })
  expect(validateSuiteCatalogAdapters([npx()], [entryNpx], context))
    .toMatchObject({ okay: false, code: 'invalid-adapter-params', detail: 'intercept-npx: interception would replace the checked entry command' })

  const link = (overrides: Record<string, unknown> = {}) => call('link-shared-dependency', { item: 'tools', command: 'tool', dependency: 'chromium', executable: 'chromium-headless-shell', environment: 'TOOL_BROWSER', ...overrides })
  expect(validateSuiteCatalogAdapters([link()], [runnerItem()], context)).toMatchObject({ okay: true })
  invalid(link({ dependency: 'ffmpeg' })); invalid(link({ executable: 'bad name' })); invalid(link({ environment: 'lowercase' }))
  // One adapter of each kind per command: a second link would be silently dropped by the wrapper otherwise.
  const duplicateLink = validateSuiteCatalogAdapters([link(), link({ environment: 'TOOL_BROWSER_2' })], [runnerItem()], context)
  expect(duplicateLink).toMatchObject({ okay: false, code: 'invalid-adapter-params' })
  // Deterministic validation and helper rendering.
  expect(validateSuiteCatalogAdapters([token()], [runnerItem()], context)).toEqual(validateSuiteCatalogAdapters([token()], [runnerItem()], context))
  const validatedToken = validateSuiteCatalogAdapters([token()], [runnerItem()], context)
  if (!validatedToken.okay) throw new Error('token adapter was rejected')
  const credentialAdapter = validatedToken.adapters.find(adapter => adapter.kind === 'credential-token')!
  if (credentialAdapter.kind !== 'credential-token') throw new Error('unexpected adapter')
  const helper = credentialTokenHelper(credentialAdapter).join('\n')
  // The helper only names the declared variables; the runtime secrecy check lives in the Feishu spec, which feeds
  // fixture credentials and a fixture response token through the generated wrapper.
  expect(helper).toContain('process.env["APP_ID"]')
  expect(helper).toContain('process.env["APP_SECRET"]')
})
