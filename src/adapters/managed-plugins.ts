import type { HostPreparationCache } from './host-preparation-cache.js'
import { applyManagedAccess } from '../dsh/managed-plugin-access.js'
import type { PluginEntryConfig } from '../domain/plugin-access.js'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PreparedPlugin } from '../domain/plugin-library.js'

export interface ManagedPluginMounts {
  readonly patch: string
  readonly volumes: readonly { host: string, mounted: string }[]
  readonly failures: readonly string[]
  readonly modulePrefixes: Readonly<Record<string, string>>
  readonly expertEntries: Readonly<Record<string, readonly Record<string, unknown>[]>>
}
/** Immutable per-start configuration; only selected prepared artifacts enter the member container. */
export async function prepareManagedPlugins(dataRoot: string, spaceId: string, plugins: readonly PreparedPlugin[], container: boolean, accessEntries: Readonly<Record<string, Readonly<Record<string, PluginEntryConfig>>>> = {}, globalPackages: readonly string[] = plugins.map(row => row.packageName), cache?: HostPreparationCache): Promise<ManagedPluginMounts | undefined> {
  if (cache) return await cache.prepare(`managed:${spaceId}`, [container, plugins, accessEntries, globalPackages], await preparationSources(dataRoot, plugins), [resolve(dataRoot, 'plugins/instances', spaceId)], () => prepareManagedPlugins(dataRoot, spaceId, plugins, container, accessEntries, globalPackages), value => !value?.failures.length)
  if (!plugins.length) return undefined
  const directory = resolve(dataRoot, 'plugins/instances', spaceId)
  await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true, mode: 0o700 })
  const mounted = container ? '/dsh-phalanx/managed-config' : directory
  const volumes = [{ host: directory, mounted }]
  const overlays: unknown[] = []; const failures: string[] = []; const modulePrefixes: Record<string, string> = {}
  const expertEntries: Record<string, Record<string, unknown>[]> = {}
  for (const plugin of plugins) {
    try {
      const prepared = resolve(dataRoot, 'plugins', plugin.artifact, 'prepared', plugin.preparationId ?? plugin.runtimeRevision)
      if (!prepared.startsWith(`${resolve(dataRoot, 'plugins/artifacts')}/`)) throw new Error('Invalid artifact path')
      const prefix = 'phalanx-managed-' + createHash('sha256').update(plugin.packageName).digest('hex').slice(0, 16)
      const artifact = container ? `/dsh-phalanx/artifacts/${prefix}` : prepared
      const patches = JSON.parse(await readFile(join(prepared, 'managed.patch.json'), 'utf8')) as Array<{ insert?: Array<{ config: { path: string } }> }>
      const files: Array<{ path: string, data: string }> = []
      for (const patch of patches) for (const row of patch.insert ?? []) {
        const filename = row.config.path.slice('/artifact/'.length)
        if (!row.config.path.startsWith('/artifact/') || !new RegExp(`^${prefix}-entries-[0-9]+\\.json$`, 'u').test(filename)) throw new Error('Invalid managed include')
        const entries = JSON.parse(await readFile(join(prepared, filename), 'utf8')) as Array<Record<string, unknown>>
        const relocate = (rows: Array<Record<string, unknown>>) => { for (const entry of rows) {
          if (typeof entry.name === 'string' && entry.name.startsWith('/artifact/')) entry.name = artifact + entry.name.slice('/artifact'.length)
          if (entry.group && Array.isArray(entry.config)) relocate(entry.config as Array<Record<string, unknown>>)

        } }
        relocate(entries); applyManagedAccess(entries, prefix, accessEntries[plugin.packageName]); files.push({ path: join(directory, filename), data: JSON.stringify(entries) })
        row.config.path = join(mounted, filename)
      }
      for (const file of files) await writeFile(file.path, file.data, { mode: 0o600 })
      if (globalPackages.includes(plugin.packageName)) {
        overlays.push(...patches)
        modulePrefixes[plugin.packageName] = `${artifact}/node_modules/${plugin.packageName}/`
      } else expertEntries[plugin.packageName] = patches.flatMap(patch => patch.insert ?? [])
      volumes.push({ host: prepared, mounted: artifact })
    } catch { failures.push(plugin.packageName) }
  }
  await writeFile(join(directory, 'overlay.json'), JSON.stringify(overlays), { mode: 0o600 })
  return { patch: join(mounted, 'overlay.json'), volumes, failures, modulePrefixes, expertEntries }
}

async function preparationSources(dataRoot: string, plugins: readonly PreparedPlugin[]): Promise<string[]> {
  return (await Promise.all(plugins.map(async plugin => {
    const directory = resolve(dataRoot, 'plugins', plugin.artifact, 'prepared', plugin.preparationId ?? plugin.runtimeRevision)
    if (!directory.startsWith(`${resolve(dataRoot, 'plugins/artifacts')}/`)) return []
    try { return ['managed.patch.json', ...(await readdir(directory)).filter(name => /^phalanx-managed-[a-f0-9]+-entries-[0-9]+\.json$/u.test(name))].map(name => join(directory, name)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [join(directory, 'managed.patch.json')]; throw error }
  }))).flat()
}
