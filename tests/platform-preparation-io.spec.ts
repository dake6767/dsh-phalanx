import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { HostPreparationCache } from '../src/adapters/host-preparation-cache.js'
import { prepareCommunityPlatformPlugin } from '../src/adapters/community-platform-plugin.js'
import { platformPluginDirectory } from '../src/dsh/community-platform-plugin.js'
import { FileCommunityMaintenance } from '../src/adapters/community-maintenance.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: vi.fn(actual.readFile), readdir: vi.fn(actual.readdir) }
})

it('refuses to replace an existing mismatched parser during maintenance and preserves its old bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'parser-maintenance-')),
    marker = join(root, 'maintenance'),
    maintenance = new FileCommunityMaintenance(marker),
    parser = join(root, platformPluginDirectory, 'yaml/package.json'),
    old = '{"name":"yaml","version":"earlier"}\n'
  try {
    await prepareCommunityPlatformPlugin(root, false)
    await writeFile(parser, old)
    await writeFile(marker, 'closed')
    await expect(prepareCommunityPlatformPlugin(root, false, undefined, () => !maintenance.closed())).rejects.toThrow('maintenance')
    expect(await readFile(parser, 'utf8')).toBe(old)
    expect((await readdir(join(root, platformPluginDirectory))).filter(name => name.startsWith('yaml.'))).toEqual([])
    await rm(marker)
    await prepareCommunityPlatformPlugin(root, false, undefined, () => !maintenance.closed())
    expect(await readFile(parser, 'utf8')).not.toBe(old)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('reuses the published platform without walking the pinned parser dependency tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'platform-preparation-io-')),
    cache = new HostPreparationCache()
  try {
    const patch = await prepareCommunityPlatformPlugin(root, false, cache)
    vi.mocked(readFile).mockClear()
    vi.mocked(readdir).mockClear()
    expect(await prepareCommunityPlatformPlugin(root, false, cache)).toBe(patch)
    // No republishing: this distinguishes a cache hit from a repeated build.
    expect(vi.mocked(readFile).mock.calls).toEqual([])
    const parser = join(root, platformPluginDirectory, 'yaml')
    expect(
      vi
        .mocked(readdir)
        .mock.calls.map(([path]) => String(path))
        .filter(path => path === parser || path.startsWith(parser + '/')),
    ).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
