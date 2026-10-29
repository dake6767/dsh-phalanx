import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { futurePluginYieldEntries, readonlyPreinstallPlugins } from '../src/adapters/preinstall-plugin-coordination.js'
import { preparePluginCoordination } from '../src/adapters/plugin-coordination.js'
import type { PreparedPlugin } from '../src/domain/plugin-library.js'

const plugin: PreparedPlugin = {
  packageName: 'example',
  version: '1.0.0',
  artifact: 'artifacts/example',
  preparationId: 'checked',
  integrity: 'sha512-fixture',
  runtimeRevision: 'revision',
  title: '',
  description: '',
  dependencies: {},
  bundlePatch: JSON.stringify([{ insert: [{ id: 'group', name: 'cordis:group', group: true, config: [{ id: 'nested', name: '../src/plugin.mjs' }] }] }]),
}

it('protects a future native bundle before installation and releases only owned overrides when readonly access ends', async () => {
  const root = await mkdtemp(join(tmpdir(), 'future-native-yield-')),
    home = join(root, 'home'),
    profile = join(home, '.dsh/profiles/web')
  const prepared = join(root, 'plugins/artifacts/example/prepared/checked'),
    directory = join(prepared, 'node_modules/example')
  try {
    await mkdir(join(directory, 'patches'), { recursive: true })
    await mkdir(profile, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'example', version: '1.0.0', dsh: { bundle: { patch: './patches/tools.yml' } } }))
    await writeFile(join(directory, 'patches/tools.yml'), plugin.bundlePatch)
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: member-choice\n  disabled: true\n')
    const future = await futurePluginYieldEntries(root, [plugin], '/dsh-phalanx/home')
    expect(future.failures).toEqual([])
    expect(future.entries).toContainEqual({
      id: 'nested',
      name: 'file:///dsh-phalanx/home/.dsh/profiles/web/node_modules/example/src/plugin.mjs',
      disabled: true,
    })
    await preparePluginCoordination(home, [], { yielding: () => [] }, '/dsh-phalanx/home', future.entries)
    const yielding = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    expect(yielding).toContain('phalanx-managed-yield')
    expect(yielding).toContain('id: nested')
    await preparePluginCoordination(home, [], { yielding: () => [] }, '/dsh-phalanx/home')
    const released = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    expect(released).not.toContain('phalanx-managed-yield')
    expect(released).toContain('id: member-choice')
    expect(released).toContain('disabled: true')
    await rm(join(directory, 'patches/tools.yml'))
    await writeFile(join(root, 'outside.yml'), plugin.bundlePatch)
    await symlink(join(root, 'outside.yml'), join(directory, 'patches/tools.yml'))
    expect(await futurePluginYieldEntries(root, [plugin], '/dsh-phalanx/home')).toEqual({ entries: [], failures: ['example'] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('includes successful expert scoped projection without globalizing it, and excludes failed package or preset preparation', () => {
  const input = {
    plugins: [plugin],
    global: [] as PreparedPlugin[],
    managed: { failures: [] as string[], expertEntries: { example: [{ id: 'scoped' }] } },
    experts: [{ expert: { id: 'expert', plugins: ['example'] } }],
    preparedExperts: { expected: [{ id: 'expert', preset: 'preset' }] },
  }
  expect(readonlyPreinstallPlugins(input)).toEqual([plugin])
  expect(input.global).toEqual([])
  input.managed.failures = ['example']
  expect(readonlyPreinstallPlugins(input)).toEqual([])
  input.managed.failures = []
  input.preparedExperts.expected = []
  expect(readonlyPreinstallPlugins(input)).toEqual([])
  input.preparedExperts.expected = [{ id: 'expert', preset: 'preset' }]
  // A projected expert may lack an unrelated skill; its successfully projected plugin still wins.
  expect(readonlyPreinstallPlugins(input)).toEqual([plugin])
  input.global = [plugin]
  input.preparedExperts.expected = []
  expect(readonlyPreinstallPlugins(input)).toEqual([plugin])
})
