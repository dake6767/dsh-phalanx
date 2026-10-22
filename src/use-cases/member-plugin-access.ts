import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { PluginInstallationsPort } from '../ports/plugin-installations.js'
import { mapPluginValues, reservedPluginEnvironment, type PluginEntryConfig } from '../domain/plugin-access.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { MemberManagedPluginsPort } from '../ports/managed-plugins.js'
import type { MemberPluginAccessPort, PluginAccessStorePort } from '../ports/plugin-access.js'
import type { CommunityModelGatewayAccess } from '../ports/community-runtime.js'
/** Managed entries keep their templates; native deliveries receive only literal process environment. */
export class MemberPluginAccess implements MemberPluginAccessPort {
  constructor(private readonly managed: Pick<MemberManagedPluginsPort, 'effective' | 'accessible' | 'localSelection'>, private readonly store: PluginAccessStorePort, private readonly native?: { readonly accounts: Pick<CommunityAccountReaderPort, 'get'>, readonly records: Pick<PluginInstallationsPort, 'get'> }) {}
  snapshot(username: string, installed: readonly string[] = []): readonly string[] {
    const managed = this.managed.accessible?.(username) ?? this.managed.effective(username)
    return [...this.revisions(managed), ...this.nativeEnvironment(username, installed, managed).snapshot].sort()
  }
  resolve(plugins: readonly PreparedPlugin[], access: CommunityModelGatewayAccess, native?: { readonly username: string, readonly installed: readonly string[] }) {
    const environment: Record<string, string> = Object.create(null), entries: Record<string, Readonly<Record<string, PluginEntryConfig>>> = Object.create(null)
    for (const plugin of plugins) {
      const settings = this.store.get(plugin.packageName)
      if (!settings) continue
      const replace = (value: string) => value.replace(/\{access-token\}|\{upstream:([a-zA-Z0-9_-]+)\}/gu, (_, name: string | undefined) => name === undefined ? access.token
        : new URL(`/plugins/${encodeURIComponent(plugin.packageName)}/${encodeURIComponent(name)}`, access.url).href)
      for (const row of settings.environment) if (!reservedPluginEnvironment(row.name)) environment[row.name] = replace(row.value)
      entries[plugin.packageName] = mapPluginValues(settings.entries, replace) as Readonly<Record<string, PluginEntryConfig>>
    }
    const literals = native ? this.nativeEnvironment(native.username, native.installed, plugins) : { environment: {}, snapshot: [] }
    return { environment: { ...literals.environment, ...environment }, entries, snapshot: [...this.revisions(plugins), ...literals.snapshot].sort() }
  }
  private nativeEnvironment(username: string, installed: readonly string[], managed: readonly PreparedPlugin[]) {
    const account = this.native?.accounts.get(username), environment: Record<string, string> = {}, snapshot: string[] = []
    if (!account || account.disabled) return { environment, snapshot }
    const controlled = new Set([...managed.map(row => row.packageName), ...(this.managed.localSelection?.(username) ?? [])]), present = new Set(installed)
    for (const row of this.native!.records.get(account.spaceId)) {
      if (!present.has(row.packageName) || controlled.has(row.packageName)) continue
      const values = this.store.get(row.packageName)?.environment.filter(value => !reservedPluginEnvironment(value.name)
        && !value.value.includes('{access-token}') && !/\{upstream:[^{}]*\}/u.test(value.value)).map(value => [value.name, value.value] as const).sort(([a], [b]) => a.localeCompare(b)) ?? []
      if (!values.length) continue
      Object.assign(environment, Object.fromEntries(values)); snapshot.push('native:' + row.packageName + ':' + JSON.stringify(values))
    }
    return { environment, snapshot: snapshot.sort() }
  }
  private revisions(plugins: readonly PreparedPlugin[]) { return plugins.flatMap(plugin => { const settings = this.store.get(plugin.packageName); return settings ? [`${plugin.packageName}:${settings.revision}`] : [] }).sort() }
}
