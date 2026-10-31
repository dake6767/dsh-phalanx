import type { HostPreparationCache } from './host-preparation-cache.js'
import { skillUsagePlugin } from '../dsh/skill-usage.js'
import { executionShellEnvironment } from '../dsh/execution-shell-env.js'
import { contributionToolModule } from '../dsh/contribution-tool.js'
import { randomBytes } from 'node:crypto'
import { cp, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  platformPluginContainerPath,
  platformPluginDirectory,
  platformPluginModule,
  platformPluginOverlay,
  platformPluginPatch,
  platformPluginRows,
  platformPluginInclude,
} from '../dsh/community-platform-plugin.js'
import { platformPluginClient, platformPluginManifest } from '../dsh/community-platform-client.js'

/** Publish outside writable member profiles; containers receive a read-only mount. */
export async function prepareCommunityPlatformPlugin(
  dataRoot: string,
  container: boolean,
  cache?: HostPreparationCache,
  canDiscard: () => boolean = () => true,
): Promise<string> {
  const directory = join(dataRoot, platformPluginDirectory)
  const mounted = container ? platformPluginContainerPath : directory
  // The existing parser publication is keyed by its manifest. Validate fixed
  // platform outputs without scanning the immutable parser tree on each login.
  if (cache)
    return await cache.prepare(
      'platform',
      container,
      [],
      [
        { path: directory, shallow: true },
        { path: join(directory, 'yaml'), shallow: true },
        join(directory, 'yaml/package.json'),
        ...platformFiles(mounted).map(([name]) => join(directory, name)),
      ],
      () => prepareCommunityPlatformPlugin(dataRoot, container, undefined, canDiscard),
      () => true,
    )
  await mkdir(directory, { recursive: true, mode: 0o700 })
  // Ship the platform's pinned YAML parser inside the read-only plugin mount.
  // Relative imports work in both host and container runtimes without DSH dependencies.
  const yamlRoot = dirname(dirname(fileURLToPath(import.meta.resolve('yaml'))))
  const manifest = await readFile(join(yamlRoot, 'package.json'), 'utf8')
  let installed: string | undefined
  try {
    installed = await readFile(join(directory, 'yaml/package.json'), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (installed !== manifest) {
    const protectExisting = async () => {
      try {
        await lstat(join(directory, 'yaml'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (!canDiscard()) throw Error('Cannot replace the existing platform parser during maintenance')
    }
    await protectExisting()
    const staging = join(directory, `yaml.${randomBytes(8).toString('hex')}`)
    try {
      await cp(yamlRoot, staging, { recursive: true })
      await protectExisting()
      if (canDiscard()) await rm(join(directory, 'yaml'), { recursive: true, force: true })
      await rename(staging, join(directory, 'yaml'))
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  for (const [name, contents] of platformFiles(mounted)) {
    const target = join(directory, name)
    try {
      if ((await readFile(target, 'utf8')) === contents) continue
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const staging = `${target}.${randomBytes(8).toString('hex')}`
    try {
      await writeFile(staging, contents, { mode: 0o600, flag: 'wx' })
      await rename(staging, target)
    } finally {
      await rm(staging, { force: true })
    }
  }
  return join(mounted, platformPluginPatch)
}

function platformFiles(mounted: string) {
  return [
    ['skill-usage.mjs', skillUsagePlugin],
    ['execution-shell-env.mjs', executionShellEnvironment],
    ['contributions.mjs', contributionToolModule],
    ['package.json', platformPluginManifest],
    ['client.js', platformPluginClient],
    ['plugin.mjs', platformPluginModule],
    [platformPluginRows, platformPluginInclude(mounted)],
    [platformPluginPatch, platformPluginOverlay(mounted)],
  ] as const
}
