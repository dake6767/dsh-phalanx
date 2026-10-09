import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PreparedPlugin } from '../domain/plugin-library.js'

export interface ManagedPluginMounts {
  readonly patch: string
  readonly volumes: readonly { host: string, mounted: string }[]
  readonly failures: readonly string[]
  readonly modulePrefixes: Readonly<Record<string, string>>
}
/** Immutable per-start configuration; only selected prepared artifacts enter the member container. */
export async function prepareManagedPlugins(dataRoot: string, spaceId: string, plugins: readonly PreparedPlugin[], container: boolean): Promise<ManagedPluginMounts | undefined> {
  if (!plugins.length) return undefined
  const directory = resolve(dataRoot, 'plugins/instances', spaceId)
  await rm(directory, { recursive: true, force: true }); await mkdir(directory, { recursive: true, mode: 0o700 })
  const mounted = container ? '/dsh-phalanx/managed-config' : directory
  const volumes = [{ host: directory, mounted }]
  const overlays: unknown[] = []; const failures: string[] = []; const modulePrefixes: Record<string, string> = {}
  for (const plugin of plugins) {
    try {
      const prepared = resolve(dataRoot, 'plugins', plugin.artifact, 'prepared', plugin.runtimeRevision)
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
        relocate(entries); files.push({ path: join(directory, filename), data: JSON.stringify(entries) })
        row.config.path = join(mounted, filename)
      }
      for (const file of files) await writeFile(file.path, file.data, { mode: 0o600 })
      overlays.push(...patches); volumes.push({ host: prepared, mounted: artifact })
      modulePrefixes[plugin.packageName] = `${artifact}/node_modules/${plugin.packageName}/`
    } catch { failures.push(plugin.packageName) }
  }
  await writeFile(join(directory, 'overlay.json'), JSON.stringify(overlays), { mode: 0o600 })
  return { patch: join(mounted, 'overlay.json'), volumes, failures, modulePrefixes }
}
