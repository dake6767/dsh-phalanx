import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { suiteCatalog, suiteRuntimeDependencyDefinition, type SuiteCatalogExecutionItem, type SuiteCatalogRuntimeDependencyItem } from '../src/domain/suite-catalog.js'
import { PlatformExecution } from '../src/use-cases/platform-execution.js'
import type { ExecutionEvent } from '../src/domain/platform-execution.js'

const minimax = suiteCatalog.find(entry => entry.id === 'minimax')!
const tool = minimax.items.find((item): item is SuiteCatalogRuntimeDependencyItem => item.kind === 'runtime-dependency')!
const template = minimax.items.find((item): item is SuiteCatalogExecutionItem => item.kind === 'execution')!
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

/** Runs the catalog preparation with npm stubbed, so only the platform wrapper is exercised. */
async function prepared(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'suite-minimax-')); roots.push(root)
  const stubs = join(root, 'stubs'), out = join(root, 'out')
  await mkdir(stubs); await mkdir(out)
  const upstream = "console.log(JSON.stringify({ argv: process.argv.slice(2), region: process.env.MINIMAX_REGION ?? null }))"
  await writeFile(join(stubs, 'npm'), `#!/bin/sh\nmkdir -p "$RD_OUT/node_modules/mmx-cli/dist"\nprintf '%s\\n' '${upstream}' > "$RD_OUT/node_modules/mmx-cli/dist/mmx.mjs"\n`)
  await chmod(join(stubs, 'npm'), 0o755)
  const definition = suiteRuntimeDependencyDefinition(tool, 'amd64')!
  const result = spawnSync('/bin/sh', ['-c', definition.prepareCommand], { cwd: out, env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, RD_OUT: out }, encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return join(out, 'bin', 'mmx')
}
const run = (command: string, args: readonly string[], key?: string) => spawnSync(command, args, { env: { ...process.env, ...(key ? { MINIMAX_API_KEY: key } : {}), MINIMAX_REGION: 'global' }, encoding: 'utf8' })

it('ships the 0.1.15 MiniMax wrapper: key becomes an argument, region is fixed and endpoint overrides are refused', async () => {
  expect(definitionCommand()).not.toContain('registry.npmmirror.com')
  const mmx = await prepared()
  const allowed = run(mmx, ['image', 'generate', '--prompt', 'circle'], 'team-key')
  expect(allowed.status).toBe(0)
  expect(JSON.parse(allowed.stdout)).toEqual({ argv: ['image', 'generate', '--prompt', 'circle', '--api-key', 'team-key'], region: 'cn' })
  expect(JSON.parse(run(mmx, ['--version']).stdout)).toEqual({ argv: ['--version'], region: 'cn' })
  for (const option of ['--base-url', '--base-url=https://evil.example', '--verbose', '--region', '--region=global']) {
    const refused = run(mmx, ['text', 'chat', option], 'team-key')
    expect(refused.status).toBe(2)
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain('This option is disabled by the platform.')
  }
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

function definitionCommand(): string { return suiteRuntimeDependencyDefinition(tool, 'amd64')!.prepareCommand }
