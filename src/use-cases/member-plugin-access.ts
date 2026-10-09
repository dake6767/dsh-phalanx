import { mapPluginValues, reservedPluginEnvironment, type PluginEntryConfig } from '../domain/plugin-access.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { MemberManagedPluginsPort } from '../ports/managed-plugins.js'
import type { MemberPluginAccessPort, PluginAccessStorePort } from '../ports/plugin-access.js'
import type { CommunityModelGatewayAccess } from '../ports/community-runtime.js'
/** Startup projection contains member credentials only; native bundles are outside this seam. */
export class MemberPluginAccess implements MemberPluginAccessPort {
  constructor(private readonly managed: Pick<MemberManagedPluginsPort, 'effective'>, private readonly store: PluginAccessStorePort) {}
  snapshot(username: string): readonly string[] { return this.revisions(this.managed.effective(username)) }
  resolve(plugins: readonly PreparedPlugin[], access: CommunityModelGatewayAccess) {
    const environment: Record<string, string> = Object.create(null), entries: Record<string, Readonly<Record<string, PluginEntryConfig>>> = Object.create(null)
    for (const plugin of plugins) {
      const settings = this.store.get(plugin.packageName)
      if (!settings) continue
      const replace = (value: string) => value.replace(/\{access-token\}|\{upstream:([a-zA-Z0-9_-]+)\}/gu, (_, name: string | undefined) => name === undefined ? access.token
        : new URL(`/plugins/${encodeURIComponent(plugin.packageName)}/${encodeURIComponent(name)}`, access.url).href)
      for (const row of settings.environment) if (!reservedPluginEnvironment(row.name)) environment[row.name] = replace(row.value)
      entries[plugin.packageName] = mapPluginValues(settings.entries, replace) as Readonly<Record<string, PluginEntryConfig>>
    }
    return { environment, entries, snapshot: this.revisions(plugins) }
  }
  private revisions(plugins: readonly PreparedPlugin[]) { return plugins.flatMap(plugin => { const settings = this.store.get(plugin.packageName); return settings ? [`${plugin.packageName}:${settings.revision}`] : [] }).sort() }
}
