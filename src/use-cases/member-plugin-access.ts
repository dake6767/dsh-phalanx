import { assertPluginDependencyTemplate } from '../domain/plugin-access.js'
import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { PluginInstallationsPort } from '../ports/plugin-installations.js'
import { mapPluginValues, reservedPluginEnvironment, type PluginEntryConfig } from '../domain/plugin-access.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { MemberManagedPluginsPort } from '../ports/managed-plugins.js'
import type { MemberPluginAccessPort, PluginAccessStorePort } from '../ports/plugin-access.js'
import type { CommunityModelGatewayAccess } from '../ports/community-runtime.js'
/** Managed entries keep their templates; native deliveries receive only literal process environment. */
export class MemberPluginAccess implements MemberPluginAccessPort {
  constructor(private readonly managed: Pick<MemberManagedPluginsPort, 'effective' | 'accessible' | 'localSelection'>, private readonly store: PluginAccessStorePort, private readonly native?: { readonly accounts: Pick<CommunityAccountReaderPort, 'get'>, readonly records: Pick<PluginInstallationsPort, 'get'> }, private readonly dependencies?: { readonly library: Pick<PluginLibraryStorePort, 'list'>, readonly ready: (names: readonly string[]) => readonly RuntimeDependencyVersion[], readonly runtimeRevision: string }) {}
  snapshot(username: string, installed: readonly string[] = []): readonly string[] {
    const managed = this.managed.accessible?.(username) ?? this.managed.effective(username)
    return [...this.revisions(managed), ...this.nativeEnvironment(username, installed, managed).snapshot].sort()
  }
  resolve(plugins: readonly PreparedPlugin[], access: CommunityModelGatewayAccess, native?: { readonly username: string, readonly installed: readonly string[], readonly dependencyVersions?: Readonly<Record<string, RuntimeDependencyVersion>> }) {
    const environment: Record<string, string> = Object.create(null), entries: Record<string, Readonly<Record<string, PluginEntryConfig>>> = Object.create(null)
    for (const plugin of plugins) {
      const settings = this.store.get(plugin.packageName)
      if (!settings) continue
      const replace = (value: string) => value.replace(/\{access-token\}|\{upstream:([a-zA-Z0-9_-]+)\}/gu, (_, name: string | undefined) => name === undefined ? access.token
        : new URL(`/plugins/${encodeURIComponent(plugin.packageName)}/${encodeURIComponent(name)}`, access.url).href)
      for (const row of settings.environment) if (!reservedPluginEnvironment(row.name)) environment[row.name] = this.replaceDependencies(plugin.packageName, replace(row.value), native?.dependencyVersions)
      entries[plugin.packageName] = mapPluginValues(settings.entries, replace) as Readonly<Record<string, PluginEntryConfig>>
    }
    const literals = native ? this.nativeEnvironment(native.username, native.installed, plugins, native.dependencyVersions) : { environment: {}, snapshot: [] }
    return { environment: { ...literals.environment, ...environment }, entries, snapshot: [...this.revisions(plugins, native?.dependencyVersions), ...literals.snapshot].sort() }
  }
  private nativeEnvironment(username: string, installed: readonly string[], managed: readonly PreparedPlugin[], versions?: Readonly<Record<string, RuntimeDependencyVersion>>) {
    const account = this.native?.accounts.get(username), environment: Record<string, string> = {}, snapshot: string[] = []
    if (!account || account.disabled) return { environment, snapshot }
    const controlled = new Set([...managed.map(row => row.packageName), ...(this.managed.localSelection?.(username) ?? [])]), present = new Set(installed)
    for (const row of this.native!.records.get(account.spaceId)) {
      if (!present.has(row.packageName) || controlled.has(row.packageName) || !this.nativeEligible(row.packageName)) continue
      const values = this.store.get(row.packageName)?.environment.filter(value => !reservedPluginEnvironment(value.name)
        && !value.value.includes('{access-token}') && !/\{upstream:[^{}]*\}/u.test(value.value)).map(value => [value.name, this.replaceDependencies(row.packageName, value.value, versions)] as const).sort(([a], [b]) => a.localeCompare(b)) ?? []
      const dependencies = this.dependencySnapshot(row.packageName, versions)
      if (dependencies.length) snapshot.push(...dependencies.map(value => 'native:' + value))
      if (!values.length) continue
      Object.assign(environment, Object.fromEntries(values)); snapshot.push('native:' + row.packageName + ':' + JSON.stringify(values))
    }
    return { environment, snapshot: snapshot.sort() }
  }
  dependencyNames(username: string, installed: readonly string[]): readonly string[] {
    const managed = this.managed.accessible?.(username) ?? this.managed.effective(username)
    const account = this.native?.accounts.get(username)
    if (account?.disabled) return []
    const local = new Set(this.managed.localSelection?.(username) ?? [])
    const names = new Set(managed.map(row => row.packageName))
    for (const row of account ? this.native!.records.get(account.spaceId) : [])
      if (installed.includes(row.packageName) && !local.has(row.packageName) && this.nativeEligible(row.packageName)) names.add(row.packageName)
    return [...new Set([...names].flatMap(name => this.declarations(name)))].sort()
  }
  private nativeEligible(packageName: string): boolean {
    if (!this.dependencies) return true
    const row = this.dependencies.library.list().find(row => row.packageName === packageName)
    return !!row && !row.removing && !row.incompatible && row.stage === 'available' && row.current?.runtimeRevision === this.dependencies.runtimeRevision
  }
  private declarations(packageName: string) { return this.dependencies?.library.list().find(row => row.packageName === packageName)?.runtimeDependencies ?? [] }
  private bindings(packageName: string, versions?: Readonly<Record<string, RuntimeDependencyVersion>>) {
    const names = this.declarations(packageName)
    const ready = versions ? names.map(name => versions[name]) : this.dependencies?.ready(names) ?? []
    return Object.fromEntries(names.map((name, index) => {
      const version = ready[index]
      if (!version) throw new Error('Declared plugin dependency is not ready')
      return [name, version]
    }))
  }
  private replaceDependencies(packageName: string, value: string, versions?: Readonly<Record<string, RuntimeDependencyVersion>>) {
    assertPluginDependencyTemplate(value, new Set(this.declarations(packageName)))
    if (!value.includes('{dependency:')) return value
    const bindings = this.bindings(packageName, versions)
    return value.replace(/\{dependency:([^{}]*)\}/gu, (_, name: string) => bindings[name]!.mountedPath)
  }
  private dependencySnapshot(packageName: string, versions?: Readonly<Record<string, RuntimeDependencyVersion>>) {
    return Object.entries(this.bindings(packageName, versions)).map(([name, version]) => `dependency:${packageName}:${JSON.stringify([name, version.id])}`)
  }
  private revisions(plugins: readonly PreparedPlugin[], versions?: Readonly<Record<string, RuntimeDependencyVersion>>) {
    return plugins.flatMap(plugin => { const settings = this.store.get(plugin.packageName); return [...settings ? [`${plugin.packageName}:${settings.revision}`] : [], ...this.dependencySnapshot(plugin.packageName, versions)] }).sort()
  }
}
