import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readSuiteCatalog } from '../src/domain/suite-catalog-reader.js'
import { suiteRuntimeDependencyDefinition, type SuiteCatalogExecutionItem, type SuiteCatalogRuntimeDependencyItem, type SuiteCatalogSuiteEntry } from '../src/domain/suite-catalog.js'
import { PlatformExecution } from '../src/use-cases/platform-execution.js'
import type { ExecutionEvent } from '../src/domain/platform-execution.js'
import { createCatalogSigningKey, signCatalog } from './fixtures/suite-catalog-signing.js'
import { onlineCatalogEntries } from './fixtures/suite-catalog-online.js'

const key = createCatalogSigningKey()
const read = readSuiteCatalog(signCatalog(onlineCatalogEntries, key).bytes, { trustedKeys: [key], platformVersion: '0.1.19' })
if (read.status !== 'ok') throw new Error('fixture catalog was rejected')
const minimax = read.entries.find(row => row.entry.id === 'minimax')!.entry as SuiteCatalogSuiteEntry
const tool = minimax.items.find((item): item is SuiteCatalogRuntimeDependencyItem => item.kind === 'runtime-dependency')!
const template = minimax.items.find((item): item is SuiteCatalogExecutionItem => item.kind === 'execution')!
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

/** The unmodified upstream CLI: it reports the argv and region it received, exactly as the real pinned version parses them. */
const upstream = `const rn=[{flag:"--api-key <key>"},{flag:"--quiet"},{flag:"--non-interactive"}];
console.log(JSON.stringify({ argv: process.argv.slice(2), region: process.env.MINIMAX_REGION ?? null, yesMetadata: rn.some(row => row.flag === "--yes") }));
`

/** Runs the generated preparation with npm stubbed, leaving the downloaded CLI byte-identical. */
async function prepared(): Promise<{ wrapper: string, upstreamPath: string, command: string }> {
  const root = await mkdtemp(join(tmpdir(), 'suite-minimax-')); roots.push(root)
  const stubs = join(root, 'stubs'), out = join(root, 'out')
  await mkdir(stubs); await mkdir(out)
  await writeFile(join(stubs, 'npm'), `#!/bin/sh\nmkdir -p "$RD_OUT/node_modules/mmx-cli/dist"\ncat > "$RD_OUT/node_modules/mmx-cli/dist/mmx.mjs" <<'UPSTREAM'\n${upstream}UPSTREAM\n`)
  await chmod(join(stubs, 'npm'), 0o755)
  const definition = suiteRuntimeDependencyDefinition(tool, 'amd64')!
  const result = spawnSync('/bin/sh', ['-c', definition.prepareCommand], { cwd: out, env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, RD_OUT: out }, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return { wrapper: join(out, 'bin', 'mmx'), upstreamPath: join(out, 'node_modules/mmx-cli/dist/mmx.mjs'), command: definition.prepareCommand }
}
const run = (command: string, args: readonly string[], key?: string) => spawnSync(command, args, { env: { ...process.env, ...(key ? { MINIMAX_API_KEY: key } : {}), MINIMAX_REGION: 'global' }, encoding: 'utf8' })

it('removes the upstream patch and keeps the prepared CLI byte-identical', async () => {
  const { command, upstreamPath } = await prepared()
  expect(command).not.toContain('fs.readFileSync')
  expect(command).not.toContain('fs.writeFileSync')
  expect(command).not.toContain('Unexpected MiniMax CLI option metadata')
  // The only mmx.mjs reference is the exec path; there is no patch heredoc that rewrites it.
  expect(command.match(/mmx\.mjs/gu)).toHaveLength(1)
  expect(await readFile(upstreamPath, 'utf8')).toBe(upstream)
  expect(command).toContain('npm install --prefix "$RD_OUT" --ignore-scripts --no-audit --no-fund mmx-cli@1.0.28')
  expect(command).toContain('export MINIMAX_REGION=cn')
  expect(command).toContain('set -- "$@" --api-key "$MINIMAX_API_KEY"')
})

it('keeps the MiniMax key in isolated arguments, fixes the region and refuses endpoint overrides', async () => {
  const { wrapper } = await prepared()
  const allowed = run(wrapper, ['image', 'generate', '--prompt', 'circle'], 'team-key')
  expect(allowed.status).toBe(0)
  expect(JSON.parse(allowed.stdout)).toMatchObject({ argv: ['image', 'generate', '--prompt', 'circle', '--api-key', 'team-key'], region: 'cn' })
  expect(JSON.parse(run(wrapper, ['--version']).stdout)).toMatchObject({ argv: ['--version'], region: 'cn' })
  for (const option of ['--base-url', '--base-url=https://evil.example', '--verbose', '--region', '--region=global']) {
    const refused = run(wrapper, ['text', 'chat', option], 'team-key')
    expect(refused.status, option).toBe(2)
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain('This option is disabled by the platform.')
  }
})

it('rewrites the documented --yes agent flag to --non-interactive without touching other arguments', async () => {
  // 1.0.28 documents --yes but never declares it as a boolean flag. Members keep using --yes; the generated wrapper
  // maps that standalone token to the upstream-supported --non-interactive and leaves the rest of the argv alone.
  const { wrapper } = await prepared()
  const result = run(wrapper, ['image', 'generate', '--prompt', 'circle', '--quiet', '--non-interactive', '--yes'], 'team-key')
  expect(result.status).toBe(0)
  const parsed = JSON.parse(result.stdout) as { argv: string[], region: string, yesMetadata: boolean }
  expect(parsed.argv).toEqual(['image', 'generate', '--prompt', 'circle', '--quiet', '--non-interactive', '--non-interactive', '--api-key', 'team-key'])
  expect(parsed.argv).not.toContain('--yes')
  expect(parsed.yesMetadata).toBe(false)
  expect(parsed.region).toBe('cn')
  // Inline or embedded values are not flags and stay untouched.
  const inline = run(wrapper, ['image', 'generate', '--prompt', 'x', '--yes=false', '--yes=1', 'value--yes'], 'team-key')
  expect(JSON.parse(inline.stdout).argv).toEqual(['image', 'generate', '--prompt', 'x', '--yes=false', '--yes=1', 'value--yes', '--api-key', 'team-key'])
})

it('preserves a literal yes flag supplied as prompt text', async () => {
  const { wrapper } = await prepared()
  const result = run(wrapper, ['image', 'generate', '--prompt', '--yes'], 'team-key')
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout).argv).toEqual(['image', 'generate', '--prompt', '--yes', '--api-key', 'team-key'])
})

it('never writes the credential value into generated files or the preparing command', async () => {
  const { wrapper, command } = await prepared()
  expect(command).not.toContain('team-key')
  const script = await readFile(wrapper, 'utf8')
  expect(script).not.toContain('team-key')
  // The wrapper only names the environment variable; the value travels through the process environment and argv.
  expect(script).toContain('MINIMAX_API_KEY')
})

it('answers the blocked MiniMax first arguments with the fixed notice and no credential', async () => {
  expect(template.delegated).toEqual([{ command: 'mmx', blocked: ['auth', 'config', 'agent', 'update'] }])
  expect(template.variables.map(row => row.name)).toEqual(['MINIMAX_API_KEY'])
  const calls: unknown[] = []
  const execution = new PlatformExecution({ get: id => ({ id, version: 'v1' }), owns: () => true },
    { get: () => ({ enabled: true, commands: template.delegated, variables: [{ name: 'MINIMAX_API_KEY', value: 'team-secret-value', secret: true }], runtimeDependencies: ['minimax-tools'] }) },
    { run: async input => { calls.push(input); return 0 } })
  for (const first of template.delegated[0]!.blocked) {
    const events: ExecutionEvent[] = []
    expect(await execution.execute({ username: 'member', owner: 'skill:mmx-cli', command: 'mmx', argv: [first, 'show'], cwd: '/workspace', stdin: new Uint8Array() }, async event => { events.push(event) }, new AbortController().signal)).toBe(0)
    expect(events.map(event => new TextDecoder().decode(event.data)).join('')).toBe('API Key: Credentials are configured by the platform / 凭据由平台配置。\n')
  }
  expect(calls).toEqual([])
})
