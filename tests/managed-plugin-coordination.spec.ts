import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { preparePluginCoordination } from '../src/adapters/plugin-coordination.js'
import { MemberManagedPlugins } from '../src/use-cases/member-managed-plugins.js'
import type { PreparedPlugin } from '../src/domain/plugin-library.js'

it('yields the actual self-installed entry and restores only owned overrides, preserving native edits and files', async () => {
  const home = await mkdtemp(join(tmpdir(), 'plugin-coordination-'))
  const profile = join(home, '.dsh/profiles/web'); const directory = join(profile, 'node_modules/example')
  const plugin = { packageName: 'example' } as PreparedPlugin
  const selection = new MemberManagedPlugins({ get: () => undefined, listGroups: () => [] }, { list: () => [], remove: () => {}, save: () => {} }, { get: () => [], set: () => {}, remove: () => {}, retainGroups: () => {} }, 'revision')
  const patch = join(profile, 'cordis.patch.yml')
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['example'] } } }))
    await writeFile(join(directory, 'package.json'), JSON.stringify({ dsh: { bundle: { patch: ['./patch.yml'] } } }))
    await writeFile(join(directory, 'patch.yml'), '- insert:\n    - id: self-version-id\n      name: example/client\n')
    const original = '# member comment\n- id: self-version-id\n  disabled: false\n  config:\n    token: !!js process.env.MEMBER_TOKEN\n- id: another\n  disabled: true\n'
    await writeFile(patch, original)
    await preparePluginCoordination(home, [plugin], selection)
    const yielding = await readFile(patch, 'utf8')
    expect(yielding).toContain('phalanx-managed-yield'); expect(yielding).toContain('name: example/client')
    expect(yielding).toContain('token: !!js process.env.MEMBER_TOKEN')
    await preparePluginCoordination(home, [plugin], selection)
    expect(await readFile(patch, 'utf8')).toBe(yielding)
    // The native writer preserves comments; unrelated settings may be changed while managed.
    await writeFile(patch, yielding + '- id: newly-configured\n  config: { value: 7 }\n')
    await preparePluginCoordination(home, [], selection)
    const restored = await readFile(patch, 'utf8')
    expect(restored).not.toContain('phalanx-managed-yield'); expect(restored).not.toContain('name: example/client')
    expect(restored).toContain('disabled: false'); expect(restored).toContain('# member comment')
    expect(restored).toContain('value: 7'); expect(restored).toContain('token: !!js process.env.MEMBER_TOKEN')
    expect(await readFile(join(directory, 'patch.yml'), 'utf8')).toContain('self-version-id')
    await preparePluginCoordination(home, [plugin], selection)
    const edited = (await readFile(patch, 'utf8')).replace('name: example/client\n  disabled: true', 'name: example/client\n  disabled: false')
    await writeFile(patch, edited)
    await preparePluginCoordination(home, [], selection)
    expect(await readFile(patch, 'utf8')).toContain('name: example/client\n  disabled: false')
    await preparePluginCoordination(home, [plugin], selection)
    await writeFile(patch, (await readFile(patch, 'utf8')).replace('name: example/client\n  disabled: true', 'name: another/client\n  disabled: true'))
    await preparePluginCoordination(home, [], selection)
    expect(await readFile(patch, 'utf8')).toContain('name: another/client\n  disabled: true')
    await rm(join(directory, 'patch.yml')); await symlink('/etc/passwd', join(directory, 'patch.yml'))
    await expect(preparePluginCoordination(home, [plugin], selection)).rejects.toThrow()
  } finally { await rm(home, { recursive: true, force: true }) }
})

it.each([undefined, '/dsh-phalanx/home'])('anchors native yield assertions to each patch at its runtime home %s', async mountedHome => {
  const home = await mkdtemp(join(tmpdir(), 'plugin-coordination-paths-')), profile = join(home, '.dsh/profiles/web')
  const directory = join(profile, 'node_modules/example'), patch = join(profile, 'cordis.patch.yml')
  const plugin = { packageName: 'example' } as PreparedPlugin
  try {
    await mkdir(join(directory, 'patches'), { recursive: true })
    await writeFile(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['example'] } } }))
    await writeFile(join(directory, 'package.json'), JSON.stringify({ dsh: { bundle: { patch: ['./patches/tools.yml'] } } }))
    await writeFile(join(directory, 'patches/tools.yml'), JSON.stringify([{ insert: [
      { id: 'relative', name: '../src/provider.mjs' }, { id: 'absolute', name: '/member/absolute.mjs' },
      { id: 'bare', name: 'example/client' }, { id: 'url', name: 'file:///member/url.mjs' },
      { id: 'group', name: 'cordis:group', group: true, config: [{ id: 'nested', name: './nested.mjs' }] },
    ] }]))
    await writeFile(patch, '[]\n')
    await preparePluginCoordination(home, [plugin], { yielding: MemberManagedPlugins.prototype.yielding }, mountedHome)
    const source = await readFile(patch, 'utf8'), runtime = mountedHome ?? home
    expect(source).toContain(`name: file://${runtime}/.dsh/profiles/web/node_modules/example/src/provider.mjs`)
    expect(source).toContain(`name: file://${runtime}/.dsh/profiles/web/node_modules/example/patches/nested.mjs`)
    expect(source).toContain('name: file:///member/absolute.mjs'); expect(source).toContain('name: file:///member/url.mjs')
    expect(source).toContain('name: example/client'); expect(source).toContain('name: cordis:group')
    if (mountedHome) expect(source).not.toContain(home)
    await preparePluginCoordination(home, [], { yielding: MemberManagedPlugins.prototype.yielding }, mountedHome)
    expect(await readFile(patch, 'utf8')).not.toContain('phalanx-managed-yield')
  } finally { await rm(home, { recursive: true, force: true }) }
})
