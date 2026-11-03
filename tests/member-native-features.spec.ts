import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { prepareMemberNativeFeatures } from '../src/adapters/member-native-features.js'
import { dshNativeFeatures } from '../src/dsh/native-features.js'
import { inspectDataRoot } from '../src/adapters/data-root-layout.js'

it('creates private immutable generations per member and preserves in-use generations during maintenance', async () => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'native-features-'))
  try {
    const registry = dshNativeFeatures()
    const disabled = await prepareMemberNativeFeatures(dataRoot, false, 'member-one', registry.patch(['terminal', 'preset-cordis']))
    const previousBytes = await readFile(disabled.patch, 'utf8')
    const client = join(dirname(disabled.patch), 'preset-controls')
    expect((await stat(client)).mode & 0o777).toBe(0o700)
    for (const name of ['package.json', 'index.mjs', 'client.js']) expect((await stat(join(client, name))).mode & 0o777).toBe(0o600)
    const other = await prepareMemberNativeFeatures(dataRoot, false, 'member-two', registry.patch([]))
    expect(other.volumes[0]!.host).not.toBe(disabled.volumes[0]!.host)
    expect((await inspectDataRoot(dataRoot)).projections).toContain('native-features/members')
    const held = await prepareMemberNativeFeatures(dataRoot, false, 'member-one', registry.patch([]), () => false)
    expect(await readFile(disabled.patch, 'utf8')).toBe(previousBytes)
    expect(held.patch).not.toBe(disabled.patch)
    expect((await stat(held.patch)).mode & 0o777).toBe(0o600)
    expect((await stat(held.volumes[0]!.host)).mode & 0o777).toBe(0o700)
    const current = await prepareMemberNativeFeatures(dataRoot, true, 'member-one', registry.patch([]))
    expect(current.patch.startsWith('/dsh-phalanx/native-features/')).toBe(true)
    expect(await readdir(current.volumes[0]!.host)).toHaveLength(1)
    await expect(readFile(disabled.patch)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(prepareMemberNativeFeatures(dataRoot, false, '../escape', [])).rejects.toThrow('identity')
  } finally {
    await rm(dataRoot, { recursive: true, force: true })
  }
})
