// Validation: T3; real credentials: none; fixed source DSH public Loader services.
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { expertPluginLoader } from '../src/dsh/expert-plugins.js'
import { pluginServiceObserver } from '../src/dsh/plugin-service-observer.js'
import { runtimeSettings } from './support/real-dsh-kit.js'
import { assertPinnedDshRevision } from './support/real-dsh-runtime.js'

it('waits for tools, isolates a failed expert MCP and a leaking plugin, and retains its working sibling', async () => {
  assertPinnedDshRevision(runtimeSettings)
  if (!runtimeSettings.dshRoot) throw Error('Source DSH is required')
  const directory = await mkdtemp(join(tmpdir(), 'expert-loader-runtime-'))
  try {
    await writeFile(join(directory, 'loader.mjs'), expertPluginLoader)
    await writeFile(join(directory, 'sibling.mjs'), "export function apply(ctx) { ctx.on('fixture/sibling', rows => rows.push('ready')) }\n")
    await writeFile(join(directory, 'leaking.mjs'), "export function apply(ctx) { ctx.provide('fixtureLeak', {}) }\n")
    await writeFile(join(directory, 'observer.mjs'), pluginServiceObserver)
    await writeFile(
      join(directory, 'provider.mjs'),
      "export function apply(ctx) { if (process.env.FIXTURE_PROVIDER_FAIL) throw Error('provider failed'); ctx.provide('fixtureDependency', {}) }\n",
    )
    await writeFile(join(directory, 'dependent.mjs'), "export const inject = ['fixtureDependency']; export function apply() {}\n")
    await writeFile(
      join(directory, 'probe.mjs'),
      `import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
const cli = process.argv[2]
const runtime = createRequire(cli)
const load = name => import(pathToFileURL(runtime.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { Loader, Group } = await load('@deepseek-ai/cordis-plugin-loader')
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await load('@deepseek-ai/dsh-tools')
const webRuntime = createRequire(runtime.resolve('@deepseek-ai/dsh-web-app'))
const { auditRows } = await import(pathToFileURL(webRuntime.resolve('@deepseek-ai/dsh-agent-preset-registry')).href)
const ctx = new Context()
const loader = new Loader(ctx)
loader.builtins.group = Group
process.argv[1] = cli
try {
  await ctx.plugin(SystemPrompt)
  let handler
  ctx.provide('webServer', { register: row => { handler = row.handler; return () => {} } })
  await loader.root.update([
    { id: 'fixture-provider', name: new URL('./provider.mjs', import.meta.url).href },
    { id: 'observer', name: new URL('./observer.mjs', import.meta.url).href, config: { prefix: 'fixture' } },
  ])
  await loader.await()
  let services
  handler({}, { setHeader() {}, end: value => { services = JSON.parse(value) } })
  loader.remove('fixture-provider')
  process.env.FIXTURE_PROVIDER_FAIL = '1'
  await loader.root.update([{ id: 'expert-loader', name: new URL('./loader.mjs', import.meta.url).href, config: {
    id: 'expert', services, packages: [
      { failureId: 'mcp:bad', entries: [{ id: 'bad', name: runtime.resolve('@deepseek-ai/dsh-mcp-client'), config: {
        transport: 'stdio', serverName: 'p-bad', command: process.execPath, args: ['-e', 'process.exit(1)'], failOnStartupError: true,
      } }] },
      { failureId: 'plugin:sibling', entries: [{ id: 'sibling', name: new URL('./sibling.mjs', import.meta.url).href }] },
      { failureId: 'plugin:leaking', entries: [{ id: 'leaking', name: new URL('./leaking.mjs', import.meta.url).href }] },
      { failureId: 'plugin:provider', services, entries: [{ id: 'provider', name: new URL('./provider.mjs', import.meta.url).href }] },
      { failureId: 'plugin:dependent', entries: [{ id: 'dependent', name: new URL('./dependent.mjs', import.meta.url).href }] },
    ],
  } }])
  // Settle the loader while tools are still unavailable, then activate that dependency.
  await loader.await()
  await ctx.plugin(Tools, {})
  const audit = await auditRows(loader)
  const statuses = [], siblings = []
  ctx.emit('phalanx/expert-plugin-status', statuses)
  ctx.emit('fixture/sibling', siblings)
  console.log('EXPERT_LOADER_RESULT ' + JSON.stringify({ audit, statuses, siblings, services, leakedService: ctx.get('fixtureLeak') !== undefined }))
} finally { await ctx.fiber.dispose() }
`,
    )
    const { stdout } = await promisify(execFile)(process.execPath, [join(directory, 'probe.mjs'), join(runtimeSettings.dshRoot, 'apps/cli/lib/bin.js')], {
      timeout: 30000,
    })
    const result = stdout.split('\n').find(line => line.startsWith('EXPERT_LOADER_RESULT '))
    expect(JSON.parse(result!.slice('EXPERT_LOADER_RESULT '.length))).toEqual({
      audit: { failed: [], pending: [] },
      statuses: [{ id: 'expert', entries: ['mcp:bad', 'plugin:dependent', 'plugin:leaking', 'plugin:provider'] }],
      siblings: ['ready'],
      services: ['fixtureDependency'],
      leakedService: false,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
