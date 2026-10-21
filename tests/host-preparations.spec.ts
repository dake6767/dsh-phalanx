import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HostPreparationCache } from '../src/adapters/host-preparation-cache.js'
import { prepareManagedPlugins } from '../src/adapters/managed-plugins.js'
import { prepareMemberExperts } from '../src/adapters/member-experts.js'
import { prepareCommunityPlatformPlugin } from '../src/adapters/community-platform-plugin.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import type { PreparedPlugin } from '../src/domain/plugin-library.js'
import type { ExpertMemberPlan } from '../src/ports/experts.js'

it('rebuilds managed entries for access and global/expert changes and retries missing artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prepared-managed-')), cache = new HostPreparationCache()
  const plugin: PreparedPlugin = { packageName: 'example', version: '1', integrity: 'hash', artifact: 'artifacts/example', runtimeRevision: 'runtime', title: '', description: '', dependencies: {}, bundlePatch: '[]' }
  const prepared = join(root, 'plugins/artifacts/example/prepared/runtime'), prefix = 'phalanx-managed-' + createHash('sha256').update('example').digest('hex').slice(0, 16), filename = prefix + '-entries-0.json'
  const patch = JSON.stringify([{ insert: [{ config: { path: '/artifact/' + filename } }] }])
  try {
    await mkdir(prepared, { recursive: true })
    const first = await prepareManagedPlugins(root, 'member', [plugin], false, {}, ['example'], cache)
    expect(first?.failures).toEqual(['example'])
    await writeFile(join(prepared, 'managed.patch.json'), patch)
    await writeFile(join(prepared, filename), JSON.stringify([{ id: prefix + '-main', name: '/artifact/plugin.mjs', config: { label: 'old' } }]))
    const current = await prepareManagedPlugins(root, 'member', [plugin], false, {}, ['example'], cache)
    expect(current?.failures).toEqual([])
    expect(await prepareManagedPlugins(root, 'member', [plugin], false, {}, ['example'], cache)).toBe(current)
    await prepareManagedPlugins(root, 'member', [plugin], false, { example: { main: { label: 'new' } } }, ['example'], cache)
    expect(JSON.parse(await readFile(join(root, 'plugins/instances/member', filename), 'utf8'))[0].config.label).toBe('new')
    const expert = await prepareManagedPlugins(root, 'member', [plugin], false, {}, [], cache)
    expect(expert?.modulePrefixes).toEqual({}); expect(expert?.expertEntries.example).toHaveLength(1)
    await rm(join(prepared, 'managed.patch.json'))
    expect((await prepareManagedPlugins(root, 'member', [plugin], false, {}, [], cache))?.failures).toEqual(['example'])
    await writeFile(join(prepared, 'managed.patch.json'), patch)
    expect((await prepareManagedPlugins(root, 'member', [plugin], false, {}, [], cache))?.failures).toEqual([])
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('reuses expert generations only for unchanged complete plans and rechecks skill artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prepared-experts-')), cache = new HostPreparationCache()
  const config: CommunityRuntimeConfig = { dataRoot: root, command: 'fixture-dsh', args: [], defaultModel: { provider: 'fixture', model: 'fixture', upstream: { baseUrl: 'http://localhost' } } }
  const plan: ExpertMemberPlan = { expert: { id: 'writer', revision: 1, name: 'Writer', description: 'Writes', icon: '', persona: 'Write.', published: false, skills: ['writing'], skillPacks: [], plugins: [], mcp: [], model: null, examples: [] }, skills: [{ name: 'writing', description: 'Writes', hash: 'a'.repeat(64), importedAt: 0, published: false }], requestedSkills: ['writing'], globalSkills: [], failures: [] }
  const source = join(root, 'skills/artifacts', 'a'.repeat(64), 'files')
  try {
    const prepare = (plans = [plan]) => prepareMemberExperts(config, 'member', plans, undefined, undefined, undefined, cache)
    expect((await prepare()).failures).toEqual([{ id: 'writer', entries: ['skill:writing'] }])
    await mkdir(source, { recursive: true }); await writeFile(join(source, 'SKILL.md'), '---\nname: writing\ndescription: Writes\n---\nWrite.')
    const complete = await prepare(); expect(complete.failures).toEqual([])
    expect((await prepare()).patch).toBe(complete.patch)
    const changed = await prepare([{ ...plan, expert: { ...plan.expert, revision: 2 } }]); expect(changed.patch).not.toBe(complete.patch)
    await rm(source, { recursive: true, force: true })
    expect((await prepare()).failures).toEqual([{ id: 'writer', entries: ['skill:writing'] }])
  } finally { await rm(root, { recursive: true, force: true }) }
})
it('coalesces shared platform publication across members and restores changed output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'prepared-platform-')), cache = new HostPreparationCache()
  try {
    const paths = await Promise.all(Array.from({ length: 4 }, () => prepareCommunityPlatformPlugin(root, false, cache)))
    expect(new Set(paths).size).toBe(1)
    const expected = await readFile(paths[0]!, 'utf8')
    await writeFile(paths[0]!, 'changed')
    expect(await prepareCommunityPlatformPlugin(root, false, cache)).toBe(paths[0])
    expect(await readFile(paths[0]!, 'utf8')).toBe(expected)
    const parserManifest = join(root, 'platform-plugin/yaml/package.json')
    await rm(parserManifest)
    await prepareCommunityPlatformPlugin(root, false, cache)
    expect(JSON.parse(await readFile(parserManifest, 'utf8')).name).toBe('yaml')
  } finally { await rm(root, { recursive: true, force: true }) }
})
