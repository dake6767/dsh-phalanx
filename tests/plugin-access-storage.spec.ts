import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { FilePluginAccessStore } from '../src/adapters/plugin-access-store.js'
import { prepareManagedPlugins } from '../src/adapters/managed-plugins.js'
import { YamlPluginAccessSyntax } from '../src/adapters/plugin-access-syntax.js'

it('persists private templates without churning unchanged revisions and merges only owned startup entries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'access-storage-'))
  try {
    const path = join(root, 'plugins/access.json'), store = new FilePluginAccessStore(path)
    const settings = { environment: [{ name: 'PLUGIN_TOKEN', value: '{access-token}' }], entriesYaml: 'main: {}', entries: { main: {} } }
    store.save('plugin', settings); const revision = store.get('plugin')!.revision
    store.save('plugin', settings); expect(store.get('plugin')!.revision).toBe(revision)
    expect(new FilePluginAccessStore(path).get('plugin')).toEqual(store.get('plugin'))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    store.remove('plugin'); store.save('plugin', settings); expect(store.get('plugin')!.revision).not.toBe(revision)
    const prefix = 'phalanx-managed-' + createHash('sha256').update('plugin').digest('hex').slice(0, 16)
    const prepared = join(root, 'plugins/artifacts/hash/prepared/rev'); await mkdir(prepared, { recursive: true })
    const filename = prefix + '-entries-0.json'
    const original = [{ id: prefix + '-main', name: '/artifact/node_modules/plugin/index.js', config: { tools: { a: false, b: true }, list: ['original'], lazy: { __jsExpr: 'process.env.SAFE' } } }]
    await writeFile(join(prepared, filename), JSON.stringify(original))
    await writeFile(join(prepared, 'managed.patch.json'), JSON.stringify([{ insert: [{ config: { path: '/artifact/' + filename } }] }]))
    const plugin = { packageName: 'plugin', version: '1.0.0', artifact: 'artifacts/hash', integrity: 'hash', runtimeRevision: 'rev', bundlePatch: '- insert:\n  - id: main\n    name: plugin\n', dependencies: {}, title: '', description: '' }
    expect(new YamlPluginAccessSyntax().entryIds(plugin)).toEqual(['main'])
    const mount = await prepareManagedPlugins(root, 'space', [plugin], true, { plugin: { main: { tools: { a: true }, list: [1], key: 'member-token' }, removed: { key: 'ignored' } } })
    expect(mount!.failures).toEqual([])
    const output = JSON.parse(await readFile(join(root, 'plugins/instances/space', filename), 'utf8'))
    expect(output[0].config).toEqual({ tools: { a: true, b: true }, list: [1], lazy: { __jsExpr: 'process.env.SAFE' }, key: 'member-token' })
    expect(JSON.parse(await readFile(join(prepared, filename), 'utf8'))).toEqual(original)
  } finally { await rm(root, { recursive: true, force: true }) }
})
