import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { expect, it } from 'vitest'
import { prepareMemberExperts } from '../src/adapters/member-experts.js'
import type { CommunityRuntimeConfig } from '../src/domain/community-config.js'
import { installedPluginInventory } from './support/installed-plugin-inventory.js'

it('compares actual regenerated expert modules by capability while preserving all other identities', async () => {
  const root = await mkdtemp(join(tmpdir(), 'installed-plugin-inventory-'))
  const config: CommunityRuntimeConfig = {
    command: '/unavailable',
    args: [],
    dataRoot: root,
    container: { runtime: 'unused', image: 'unused', internalPort: 1, gatewayPort: 2 },
    defaultModel: { provider: 'unused', model: 'unused', upstream: { baseUrl: 'http://127.0.0.1' } },
  }
  try {
    const generatedModule = async () => {
      const result = await prepareMemberExperts(config, 'diagnosis', [])
      const volume = result.volumes[0]!
      const overlay = JSON.parse(await readFile(join(volume.host, relative(volume.mounted, result.patch)), 'utf8'))
      return overlay[0].insert[0].name as string
    }
    const first = await generatedModule(),
      second = await generatedModule()
    expect(first).not.toBe(second)
    expect(installedPluginInventory([first])).toEqual(installedPluginInventory([second]))
    expect(installedPluginInventory(['file://' + first])).toEqual(installedPluginInventory(['file://' + second]))
    expect(installedPluginInventory([first, first])).toHaveLength(2)
    expect(installedPluginInventory([first])).not.toEqual(installedPluginInventory([second.replace('plugin-status.mjs', 'plugin-loader.mjs')]))
    const unrelated = first.replace('/dsh-phalanx/experts/', '/dsh-phalanx/home/')
    expect(installedPluginInventory([unrelated])).toEqual([unrelated])
    expect(installedPluginInventory([first.replace(/generation-[^/]+/u, 'generation-not-a-uuid')])).toEqual([
      first.replace(/generation-[^/]+/u, 'generation-not-a-uuid'),
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
