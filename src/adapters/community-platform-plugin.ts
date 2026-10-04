import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { platformPluginContainerPath, platformPluginDirectory, platformPluginModule, platformPluginOverlay, platformPluginPatch, platformPluginRows, platformPluginInclude } from '../dsh/community-platform-plugin.js'

/** Publish outside writable member profiles; containers receive a read-only mount. */
export async function prepareCommunityPlatformPlugin(dataRoot: string, container: boolean): Promise<string> {
  const directory = join(dataRoot, platformPluginDirectory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const mounted = container ? platformPluginContainerPath : directory
  for (const [name, contents] of [['plugin.mjs', platformPluginModule], [platformPluginRows, platformPluginInclude(mounted)], [platformPluginPatch, platformPluginOverlay(mounted)]] as const) {
    const target = join(directory, name)
    try { if (await readFile(target, 'utf8') === contents) continue }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const staging = `${target}.${randomBytes(8).toString('hex')}`
    try { await writeFile(staging, contents, { mode: 0o600, flag: 'wx' }); await rename(staging, target) }
    finally { await rm(staging, { force: true }) }
  }
  return join(mounted, platformPluginPatch)
}
