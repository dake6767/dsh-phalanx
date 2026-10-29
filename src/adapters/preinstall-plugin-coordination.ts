import { realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { PluginYieldEntry } from '../ports/managed-plugins.js'
import { dshWebProfilePath } from '../dsh/profile-layout.js'
import { selfBundleEntries, selfBundlePatchFiles } from '../dsh/plugin-coordination.js'
import { pluginFileReader } from './plugin-coordination.js'

/** Only successfully projected global or scoped readonly declarations can claim priority. */
export function readonlyPreinstallPlugins(input: {
  readonly plugins: readonly PreparedPlugin[]
  readonly global: readonly PreparedPlugin[]
  readonly managed?: { readonly failures: readonly string[]; readonly expertEntries: Readonly<Record<string, readonly unknown[]>> }
  readonly experts: readonly { readonly expert: { readonly id: string; readonly plugins: readonly string[] } }[]
  readonly preparedExperts?: { readonly expected: readonly { readonly id: string }[] }
}): readonly PreparedPlugin[] {
  const failed = new Set(input.managed?.failures ?? []),
    names = new Set(input.global.filter(row => !failed.has(row.packageName)).map(row => row.packageName))
  const prepared = new Set(input.preparedExperts?.expected.map(row => row.id) ?? [])
  for (const plan of input.experts)
    if (prepared.has(plan.expert.id))
      for (const name of plan.expert.plugins) {
        if (!failed.has(name) && Object.hasOwn(input.managed?.expertEntries ?? {}, name)) names.add(name)
      }
  return input.plugins.filter(plugin => names.has(plugin.packageName))
}

/** Prewrite the existing owned overrides so a later native install never starts a duplicate. */
export async function futurePluginYieldEntries(
  dataRoot: string,
  plugins: readonly PreparedPlugin[],
  runtimeHome: string,
): Promise<{ readonly entries: readonly PluginYieldEntry[]; readonly failures: readonly string[] }> {
  const entries: PluginYieldEntry[] = [],
    failures: string[] = []
  for (const plugin of plugins) {
    try {
      const root = await realpath(dataRoot),
        artifacts = resolve(root, 'plugins/artifacts')
      const prepared = await realpath(resolve(root, 'plugins', plugin.artifact, 'prepared', plugin.preparationId ?? plugin.runtimeRevision))
      if (!prepared.startsWith(artifacts + '/')) throw Error('Invalid checked artifact')
      const read = await pluginFileReader(prepared),
        directory = join(prepared, 'node_modules', plugin.packageName)
      const source = await read(join(directory, 'package.json')),
        manifest = JSON.parse(source) as { name?: string; version?: string }
      if (manifest.name !== plugin.packageName || manifest.version !== plugin.version) throw Error('Checked package identity changed')
      const patches = selfBundlePatchFiles(source)
      if (patches.length !== 1) throw Error('Checked package must declare one patch')
      const patch = patches[0]!,
        path = resolve(directory, patch)
      if (!path.startsWith(directory + '/') || (await read(path)) !== plugin.bundlePatch) throw Error('Checked patch changed')
      const runtimePath = resolve(dshWebProfilePath(runtimeHome), 'node_modules', plugin.packageName, patch)
      entries.push(...selfBundleEntries([{ source: plugin.bundlePatch, runtimePath }]).map(entry => ({ ...entry, disabled: true as const })))
    } catch {
      failures.push(plugin.packageName)
    }
  }
  return { entries, failures }
}
