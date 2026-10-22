import { constants } from 'node:fs'
import { open, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { DSH_PATCH_CONFIG, DSH_PROFILE_MANIFEST, dshWebProfilePath } from '../dsh/profile-layout.js'
import { coordinateProfilePatch, selectedProfileBundles, selfBundleEntries, selfBundlePatchFiles } from '../dsh/plugin-coordination.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { MemberManagedPluginsPort, PluginYieldEntry, SelfInstalledPlugin } from '../ports/managed-plugins.js'

/** The carrier has stopped and prepareCommunityProfile has validated the directory chain. */
export async function preparePluginCoordination(home: string, selected: readonly PreparedPlugin[], policy: Pick<MemberManagedPluginsPort, 'yielding'>, runtimeHome = home, future: readonly PluginYieldEntry[] = []): Promise<void> {
  const profile = dshWebProfilePath(home)
  const read = await pluginFileReader(home)
  const bundles = selected.length ? selectedProfileBundles(await read(join(profile, DSH_PROFILE_MANIFEST), '{}')) : []
  const installed: SelfInstalledPlugin[] = []
  for (const plugin of selected) {
    if (!bundles.includes(plugin.packageName)) continue
    const directory = join(profile, 'node_modules', plugin.packageName)
    const patches = selfBundlePatchFiles(await read(join(directory, 'package.json')))
    const sources = []
    const runtimeDirectory = join(dshWebProfilePath(runtimeHome), 'node_modules', plugin.packageName)
    for (const patch of patches) sources.push({ source: await read(resolve(directory, patch)), runtimePath: resolve(runtimeDirectory, patch) })
    installed.push({ packageName: plugin.packageName, entries: selfBundleEntries(sources) })
  }
  const path = join(profile, DSH_PATCH_CONFIG)
  const source = await read(path, '[]\n')
  const entries = [...policy.yielding(selected, installed), ...future]
  const updated = coordinateProfilePatch(source, [...new Map(entries.map(entry => [JSON.stringify([entry.id, entry.name]), entry])).values()])
  if (updated === source) return
  const staged = `${path}.tmp-${randomBytes(8).toString('hex')}`
  try { await writeFile(staged, updated, { mode: 0o600, flag: 'wx' }); await rename(staged, path) }
  finally { await rm(staged, { force: true }) }
}

export async function pluginFileReader(home: string) {
  const root = await realpath(home)
  return async (path: string, missing?: string): Promise<string> => {
    try {
      const canonical = await realpath(path)
      if (!canonical.startsWith(root + '/')) throw new Error('Plugin configuration leaves the member home')
      const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Plugin configuration must be a bounded regular file')
        return await file.readFile('utf8')
      } finally { await file.close() }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && missing !== undefined) return missing; throw error }
  }
}

/** Read the native profile through the same bounded, no-follow policy as yielding. */
export async function memberProfileBundles(home: string): Promise<readonly string[]> {
  const read = await pluginFileReader(home)
  return selectedProfileBundles(await read(join(dshWebProfilePath(home), DSH_PROFILE_MANIFEST), '{}'))
}
