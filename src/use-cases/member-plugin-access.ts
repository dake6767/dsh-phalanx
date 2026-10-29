import {
  assertPluginDependencyTemplate,
  mapPluginValues,
  pluginAccessIdentity,
  pluginAccessSlot,
  reservedPluginEnvironment,
  type PluginEntryConfig,
} from '../domain/plugin-access.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { CommunityModelGatewayAccess } from '../ports/community-runtime.js'
import type { MemberManagedPluginsPort } from '../ports/managed-plugins.js'
import type { MemberPluginAccessPort, PluginAccessStorePort } from '../ports/plugin-access.js'
import type { PluginInstallationsPort } from '../ports/plugin-installations.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
/** Managed entries keep their templates; native deliveries receive only literal process environment. */
export class MemberPluginAccess implements MemberPluginAccessPort {
  constructor(
    private readonly managed: Pick<MemberManagedPluginsPort, 'effective' | 'accessible' | 'localSelection'>,
    private readonly store: PluginAccessStorePort,
    private readonly native?: { readonly accounts: Pick<CommunityAccountReaderPort, 'get'>; readonly records: Pick<PluginInstallationsPort, 'get'> },
    private readonly dependencies?: {
      readonly library: Pick<PluginLibraryStorePort, 'list'>
      readonly ready: (names: readonly string[]) => readonly RuntimeDependencyVersion[]
      readonly runtimeRevision: string
    },
  ) {}
  async snapshot(username: string, installed: readonly string[] = []): Promise<readonly string[]> {
    const managed = (await this.managed.accessible?.(username)) ?? (await this.managed.effective(username))
    return [...(await this.revisions(managed)), ...(await this.nativeEnvironment(username, installed, managed)).snapshot].sort()
  }
  async resolve(
    plugins: readonly PreparedPlugin[],
    access: CommunityModelGatewayAccess,
    native?: {
      readonly username: string
      readonly installed: readonly string[]
      readonly dependencyVersions?: Readonly<Record<string, RuntimeDependencyVersion>>
    },
  ) {
    const environment: Record<string, string> = Object.create(null),
      entries: Record<string, Readonly<Record<string, PluginEntryConfig>>> = Object.create(null)
    for (const plugin of plugins) {
      const settings = await this.store.get(plugin.packageName)
      if (!settings) continue
      const replace = (value: string) =>
        value.replace(/\{access-token\}|\{upstream:([a-zA-Z0-9_-]+)\}/gu, (_, name: string | undefined) =>
          name === undefined ? access.token : new URL(`/plugins/${encodeURIComponent(plugin.packageName)}/${encodeURIComponent(name)}`, access.url).href,
        )
      for (const row of settings.environment)
        if (!reservedPluginEnvironment(row.name))
          environment[row.name] = await this.replaceDependencies(plugin.packageName, replace(row.value), native?.dependencyVersions)
      entries[plugin.packageName] = mapPluginValues(settings.entries, (value, path) => {
        const slot = pluginAccessSlot(plugin.packageName, path)
        environment[slot] = replace(value)
        return { __jsExpr: `process.env[${JSON.stringify(slot)}]` }
      }) as Readonly<Record<string, PluginEntryConfig>>
    }
    const literals = native
      ? await this.nativeEnvironment(native.username, native.installed, plugins, native.dependencyVersions)
      : { environment: {}, snapshot: [] }
    return {
      environment: { ...literals.environment, ...environment },
      entries,
      snapshot: [...(await this.revisions(plugins, native?.dependencyVersions)), ...literals.snapshot].sort(),
    }
  }
  private async nativeEnvironment(
    username: string,
    installed: readonly string[],
    managed: readonly PreparedPlugin[],
    versions?: Readonly<Record<string, RuntimeDependencyVersion>>,
  ) {
    const account = await this.native?.accounts.get(username),
      environment: Record<string, string> = {},
      snapshot: string[] = []
    if (!account || account.disabled) return { environment, snapshot }
    const controlled = new Set([...managed.map(row => row.packageName), ...((await this.managed.localSelection?.(username)) ?? [])]),
      present = new Set(installed)
    for (const row of await this.native!.records.get(account.spaceId)) {
      if (!present.has(row.packageName) || controlled.has(row.packageName) || !(await this.nativeEligible(row.packageName))) continue
      const values = (
        await Promise.all(
          (await this.store.get(row.packageName))?.environment
            .filter(value => !reservedPluginEnvironment(value.name) && !value.value.includes('{access-token}') && !/\{upstream:[^{}]*\}/u.test(value.value))
            .map(async value => [value.name, await this.replaceDependencies(row.packageName, value.value, versions)] as const) ?? [],
        )
      ).sort(([a], [b]) => a.localeCompare(b))
      const dependencies = await this.dependencySnapshot(row.packageName, versions)
      if (dependencies.length) snapshot.push(...dependencies.map(value => 'native:' + value))
      if (!values.length) continue
      Object.assign(environment, Object.fromEntries(values))
      snapshot.push(
        'native:' + row.packageName + ':' + pluginAccessIdentity({ environment: values.map(([name, value]) => ({ name, value })), entriesYaml: '' }),
      )
    }
    return { environment, snapshot: snapshot.sort() }
  }
  async dependencyNames(username: string, installed: readonly string[]): Promise<readonly string[]> {
    const managed = (await this.managed.accessible?.(username)) ?? (await this.managed.effective(username))
    const account = await this.native?.accounts.get(username)
    if (account?.disabled) return []
    const local = new Set((await this.managed.localSelection?.(username)) ?? [])
    const names = new Set(managed.map(row => row.packageName))
    for (const row of account ? await this.native!.records.get(account.spaceId) : [])
      if (installed.includes(row.packageName) && !local.has(row.packageName) && (await this.nativeEligible(row.packageName))) names.add(row.packageName)
    return [...new Set((await Promise.all([...names].map(async name => await this.declarations(name)))).flat())].sort()
  }
  private async nativeEligible(packageName: string): Promise<boolean> {
    if (!this.dependencies) return true
    const row = (await this.dependencies.library.list()).find(row => row.packageName === packageName)
    return !!row && !row.removing && !row.incompatible && row.stage === 'available' && row.current?.runtimeRevision === this.dependencies.runtimeRevision
  }
  private async declarations(packageName: string) {
    return (await this.dependencies?.library.list())?.find(row => row.packageName === packageName)?.runtimeDependencies ?? []
  }
  private async bindings(packageName: string, versions?: Readonly<Record<string, RuntimeDependencyVersion>>) {
    const names = await this.declarations(packageName)
    const ready = versions ? names.map(name => versions[name]) : (this.dependencies?.ready(names) ?? [])
    return Object.fromEntries(
      names.map((name, index) => {
        const version = ready[index]
        if (!version) throw new Error('Declared plugin dependency is not ready')
        return [name, version]
      }),
    )
  }
  private async replaceDependencies(packageName: string, value: string, versions?: Readonly<Record<string, RuntimeDependencyVersion>>) {
    assertPluginDependencyTemplate(value, new Set(await this.declarations(packageName)))
    if (!value.includes('{dependency:')) return value
    const bindings = await this.bindings(packageName, versions)
    return value.replace(/\{dependency:([^{}]*)\}/gu, (_, name: string) => bindings[name]!.mountedPath)
  }
  private async dependencySnapshot(packageName: string, versions?: Readonly<Record<string, RuntimeDependencyVersion>>) {
    return Object.entries(await this.bindings(packageName, versions)).map(
      ([name, version]) => `dependency:${packageName}:${JSON.stringify([name, version.id])}`,
    )
  }
  private async revisions(plugins: readonly PreparedPlugin[], versions?: Readonly<Record<string, RuntimeDependencyVersion>>) {
    return (
      await Promise.all(
        plugins.map(async plugin => {
          const settings = await this.store.get(plugin.packageName)
          return [...(settings ? [`${plugin.packageName}:${settings.revision}`] : []), ...(await this.dependencySnapshot(plugin.packageName, versions))]
        }),
      )
    )
      .flat()
      .sort()
  }
}
