import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readlink, rename, rm, symlink } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { CommunityRuntimeConfig } from '../domain/community-config.js'
import { PLAYWRIGHT_BROWSERS_ENV, type MemberPlaywrightBrowserResource } from '../domain/suite-resource-bindings.js'

async function readBrowserRoot(directory: string) {
  return readdir(directory, { withFileTypes: true }).catch(() => [])
}

export async function preparedBrowserDirectories(directory: string): Promise<readonly string[]> {
  return (await readBrowserRoot(directory)).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

const memberPlaywrightMount = '/dsh-phalanx/playwright-browsers'

/** Project immutable dependency paths into the single cache root Playwright expects. */
export async function prepareMemberPlaywrightBrowsers(
  dataRoot: string,
  container: boolean,
  configuredPath: string | undefined,
  resources: readonly MemberPlaywrightBrowserResource[],
  reject: (name: string) => void = () => {},
) {
  const browsers = resources.filter(resource => resource.chromiumBuild !== undefined)
  if (!browsers.length) return
  const legacy = resources.find(
    resource => resource.chromiumBuild === undefined && configuredPath === (container ? resource.mountedDirectory : resource.directory),
  )
  // Only a signed legacy binding can be combined with the new cache.
  if (configuredPath !== undefined && !legacy) {
    for (const browser of browsers) reject(browser.packageName)
    return
  }

  const links = new Map<string, string>()
  let accepted = false
  for (const resource of [...(legacy ? [legacy] : []), ...browsers]) {
    const entries = await readBrowserRoot(resource.directory)
    const selected = resource.directories ?? entries.map(entry => entry.name)
    const additions = selected.map(name => [name, container ? posix.join(resource.mountedDirectory, name) : join(resource.directory, name)] as const)
    if (
      resource.packageName &&
      (!selected.every(name => entries.some(entry => entry.name === name && entry.isDirectory())) ||
        additions.some(([name, target]) => links.has(name) && links.get(name) !== target))
    ) {
      reject(resource.packageName)
      continue
    }
    if (resource.packageName) accepted = true
    for (const [name, target] of additions) links.set(name, target)
  }
  if (!accepted) return

  const contents = [...links].sort(([a], [b]) => a.localeCompare(b))
  const cache = join(dataRoot, 'playwright-browsers')
  await mkdir(cache, { recursive: true, mode: 0o700 })
  const directory = join(cache, createHash('sha256').update(JSON.stringify(contents)).digest('hex'))
  if (
    !(await lstat(directory).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }))
  ) {
    const staging = await mkdtemp(join(cache, '.prepare-'))
    try {
      for (const [name, target] of contents) await symlink(target, join(staging, name))
      await rename(staging, directory).catch(error => {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      })
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
  }
  if (!(await lstat(directory)).isDirectory() || (await readdir(directory)).length !== contents.length)
    throw new Error('Prepared Playwright cache layout changed')
  for (const [name, target] of contents) if ((await readlink(join(directory, name))) !== target) throw new Error('Prepared Playwright cache layout changed')

  return { path: container ? memberPlaywrightMount : directory, volumes: container ? [{ host: directory, mounted: memberPlaywrightMount }] : [] }
}

export async function applyMemberPlaywrightBrowsers(
  config: CommunityRuntimeConfig,
  environment: Record<string, string>,
  resources: readonly MemberPlaywrightBrowserResource[] | undefined,
  blocked: Set<string>,
) {
  if (!resources?.length) return []
  const configuredPath = environment[PLAYWRIGHT_BROWSERS_ENV] ?? config.environment?.[PLAYWRIGHT_BROWSERS_ENV]
  const cache = await prepareMemberPlaywrightBrowsers(config.dataRoot, config.container !== undefined, configuredPath, resources, name => blocked.add(name))
  if (!cache) return []
  environment[PLAYWRIGHT_BROWSERS_ENV] = cache.path
  return cache.volumes
}
