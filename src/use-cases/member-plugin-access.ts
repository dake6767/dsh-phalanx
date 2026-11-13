import {
  assertPluginDependencyTemplate,
  mapPluginValues,
  pluginAccessIdentity,
  pluginAccessSlot,
  reservedPluginEnvironment,
  type PluginEntryConfig,
} from '../domain/plugin-access.js'
import {
  nativePluginDependencyPlan,
  type NativePluginArchiveFacts,
  type NativePluginDependencyPlan,
  type NativePluginDependencyPlans,
} from '../domain/plugin-preinstall.js'
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
  async snapshot(username: string, installed: readonly string[] = [], archives: NativePluginArchiveFacts = {}): Promise<readonly string[]> {
    const managed = (await this.managed.accessible?.(username)) ?? (await this.managed.effective(username))
    const resources = await this.nativeDependencyPlans(username, archives)
    const ready = Object.fromEntries(
      Object.entries(resources).filter(([, plan]) => {
        try {
          this.dependencies?.ready(plan.dependencies)
          return true
        } catch {
          return false
        }
      }),
    )
    return [...(await this.revisions(managed)), ...(await this.nativeEnvironment(username, installed, managed, undefined, [], ready)).snapshot].sort()
  }
  async resolve(
    plugins: readonly PreparedPlugin[],
    access: CommunityModelGatewayAccess,
    native?: {
      readonly username: string
      readonly installed: readonly string[]
      readonly preinstall?: readonly string[]
      readonly nativeResources?: NativePluginDependencyPlans
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
      ? await this.nativeEnvironment(native.username, native.installed, plugins, native.dependencyVersions, native.preinstall, native.nativeResources)
      : { environment: {}, snapshot: [], failures: [] }
    return {
      environment: { ...literals.environment, ...environment },
      entries,
      snapshot: [...(await this.revisions(plugins, native?.dependencyVersions)), ...literals.snapshot].sort(),
      ...(literals.failures.length ? { nativeFailures: literals.failures } : {}),
    }
  }
  private async nativeEnvironment(
    username: string,
    installed: readonly string[],
    managed: readonly PreparedPlugin[],
    versions?: Readonly<Record<string, RuntimeDependencyVersion>>,
    preinstall: readonly string[] = [],
    nativeResources: NativePluginDependencyPlans = {},
  ) {
    const account = await this.native?.accounts.get(username),
      environment: Record<string, string> = {},
      snapshot: string[] = [],
      failures: string[] = []
    if (!account || account.disabled) return { environment, snapshot, failures }
    const controlled = new Set([...managed.map(row => row.packageName), ...((await this.managed.localSelection?.(username)) ?? [])]),
      present = new Set(installed)
    const deliveries = (await this.native!.records.get(account.spaceId)).flatMap(row => (present.has(row.packageName) ? [row.packageName] : []))
    for (const packageName of new Set([...deliveries, ...preinstall])) {
      if (controlled.has(packageName)) continue
      const frozen = Object.hasOwn(nativeResources, packageName) ? nativeResources[packageName] : undefined
      const library = await this.libraryRow(packageName)
      if (this.dependencies && !this.eligible(library)) {
        if (frozen) failures.push(packageName)
        continue
      }
      if (library?.suiteResourceBindings?.length && !frozen) continue
      if (frozen && (!library || nativePluginDependencyPlan(library).identity !== frozen.identity)) {
        failures.push(packageName)
        continue
      }
      const settings = await this.store.get(packageName)
      const values =
        settings?.environment.filter(
          value => !reservedPluginEnvironment(value.name) && !value.value.includes('{access-token}') && !/\{upstream:[^{}]*\}/u.test(value.value),
        ) ?? []
      try {
        const names = frozen?.dependencies ?? (await this.declarations(packageName))
        const dependencies = this.resolvedBindings(names, versions)
        const resolved = values.map(({ name, value }) => [name, this.boundValue(value, names, dependencies)] as const).sort(([a], [b]) => a.localeCompare(b))
        const current = frozen ? await this.libraryRow(packageName) : undefined
        if (frozen && (!current || !this.eligible(current) || nativePluginDependencyPlan(current).identity !== frozen.identity)) {
          failures.push(packageName)
          continue
        }
        const access = Object.entries(dependencies).map(([name, version]) => 'native:dependency:' + packageName + ':' + JSON.stringify([name, version.id]))
        snapshot.push(...access)
        if (!resolved.length) continue
        Object.assign(environment, Object.fromEntries(resolved))
        snapshot.push(
          'native:' + packageName + ':' + pluginAccessIdentity({ environment: resolved.map(([name, value]) => ({ name, value })), entriesYaml: '' }),
        )
      } catch (error) {
        if (!frozen) throw error
        failures.push(packageName)
      }
    }
    return { environment, snapshot: snapshot.sort(), failures }
  }
  async dependencyNames(username: string, installed: readonly string[]): Promise<readonly string[]> {
    const managed = (await this.managed.accessible?.(username)) ?? (await this.managed.effective(username))
    const account = await this.native?.accounts.get(username)
    if (account?.disabled) return []
    const local = new Set((await this.managed.localSelection?.(username)) ?? [])
    const names = new Set(managed.map(row => row.packageName))
    for (const row of account ? await this.native!.records.get(account.spaceId) : [])
      if (
        installed.includes(row.packageName) &&
        !local.has(row.packageName) &&
        (await this.nativeEligible(row.packageName)) &&
        !(await this.libraryRow(row.packageName))?.suiteResourceBindings?.length
      )
        names.add(row.packageName)
    return [...new Set((await Promise.all([...names].map(async name => await this.declarations(name)))).flat())].sort()
  }
  async nativeDependencyPlans(username: string, archives: NativePluginArchiveFacts): Promise<NativePluginDependencyPlans> {
    if (!this.native || !this.dependencies || !Object.keys(archives).length) return {}
    const account = await this.native.accounts.get(username)
    if (!account || account.disabled) return {}
    const [library, delivered, local, managed] = await Promise.all([
      this.dependencies.library.list(),
      this.native.records.get(account.spaceId),
      this.managed.localSelection?.(username),
      this.managed.effective(username),
    ])
    const excluded = new Set([...(local ?? []), ...managed.map(row => row.packageName)])
    return Object.fromEntries(
      delivered.flatMap(record => {
        if (excluded.has(record.packageName)) return []
        const actual = archives[record.packageName]
        if (!actual || actual.integrity !== record.integrity || actual.version !== record.version) return []
        const row = library.find(row => row.packageName === record.packageName)
        if (
          !row?.suiteOrigin ||
          row.suiteOrigin !== record.resourceOrigin ||
          !row.suiteResourceBindings?.length ||
          row.removing ||
          row.incompatible ||
          row.stage !== 'available' ||
          row.current?.version !== actual.version ||
          row.current.integrity !== actual.integrity ||
          row.current.runtimeRevision !== this.dependencies!.runtimeRevision
        )
          return []
        return [[record.packageName, nativePluginDependencyPlan(row)]]
      }),
    )
  }
  private async libraryRow(packageName: string) {
    return (await this.dependencies?.library.list())?.find(row => row.packageName === packageName)
  }
  private eligible(row: Awaited<ReturnType<MemberPluginAccess['libraryRow']>>) {
    return !!row && !row.removing && !row.incompatible && row.stage === 'available' && row.current?.runtimeRevision === this.dependencies?.runtimeRevision
  }
  private async nativeEligible(packageName: string): Promise<boolean> {
    return !this.dependencies || this.eligible(await this.libraryRow(packageName))
  }
  private async declarations(packageName: string) {
    return (await this.libraryRow(packageName))?.runtimeDependencies ?? []
  }
  private async bindings(packageName: string, versions?: Readonly<Record<string, RuntimeDependencyVersion>>) {
    return this.resolvedBindings(await this.declarations(packageName), versions)
  }
  private resolvedBindings(names: NativePluginDependencyPlan['dependencies'], versions?: Readonly<Record<string, RuntimeDependencyVersion>>) {
    const ready = versions ? names.map(name => versions[name]) : (this.dependencies?.ready(names) ?? [])
    return Object.fromEntries(
      names.map((name, index) => {
        const version = ready[index]
        if (!version) throw new Error('Declared plugin dependency is not ready')
        return [name, version]
      }),
    )
  }
  private boundValue(value: string, names: readonly string[], bindings: Readonly<Record<string, RuntimeDependencyVersion>>) {
    assertPluginDependencyTemplate(value, new Set(names))
    return value.replace(/\{dependency:([^{}]*)\}/gu, (_, name: string) => bindings[name]!.mountedPath)
  }
  private async replaceDependencies(packageName: string, value: string, versions?: Readonly<Record<string, RuntimeDependencyVersion>>) {
    const names = await this.declarations(packageName)
    if (!value.includes('{dependency:')) return this.boundValue(value, names, {})
    return this.boundValue(value, names, this.resolvedBindings(names, versions))
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
