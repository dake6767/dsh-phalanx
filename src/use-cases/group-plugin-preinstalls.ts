import { nativePluginDependencyPlan, preinstallCandidates, type PluginPreinstallPlan } from '../domain/plugin-preinstall.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginGroupConfigurationPort } from '../ports/managed-plugins.js'
import type { PluginInstallationsPort } from '../ports/plugin-installations.js'
import type { PluginPreinstallPlanningPort } from '../ports/plugin-preinstalls.js'

/** Group and delivery eligibility share one checked-library policy at planning and execution. */
export class GroupPluginPreinstalls implements PluginPreinstallPlanningPort {
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly library: Pick<PluginLibraryStorePort, 'list'>,
    private readonly groups: Pick<PluginGroupConfigurationPort, 'preinstalls'>,
    private readonly records: Pick<PluginInstallationsPort, 'get'>,
    private readonly runtimeRevision: string,
    private readonly installedServiceOwner?: (packageName: string) => Promise<string | undefined>,
  ) {}
  async plan(username: string, installed: readonly string[]): Promise<PluginPreinstallPlan | undefined> {
    const account = await this.accounts.get(username)
    if (!account || account.disabled || !(await this.accounts.listGroups()).some(group => group.id === account.groupId)) return undefined
    const library = await this.library.list()
    const plugins = preinstallCandidates({
      account,
      groupId: account.groupId,
      packages: await this.groups.preinstalls(account.groupId),
      deliveries: await this.records.get(account.spaceId),
      installed,
      library,
      runtimeRevision: this.runtimeRevision,
    })
    const firstEntry = (
      await Promise.all(
        plugins.map(async plugin => {
          const row = library.find(item => item.packageName === plugin.packageName)
          if (!row?.suiteOrigin) return undefined
          if (row.suiteResourceBindings?.length || (await this.installedServiceOwner?.(plugin.packageName)) === plugin.integrity) return plugin.packageName
          return undefined
        }),
      )
    ).filter(name => name !== undefined)
    return {
      actor: { username, spaceId: account.spaceId, sessionEpoch: account.sessionEpoch },
      groupId: account.groupId,
      plugins: structuredClone(plugins),
      ...(firstEntry.length
        ? {
            firstEntry,
            dependencies: Object.fromEntries(firstEntry.map(name => [name, nativePluginDependencyPlan(library.find(row => row.packageName === name)!)])),
          }
        : {}),
    }
  }
  async current(plan: PluginPreinstallPlan, plugin: PreparedPlugin): Promise<'ready' | 'restart-required' | 'cancelled'> {
    const account = await this.accounts.get(plan.actor.username)
    if (
      !account ||
      account.disabled ||
      account.spaceId !== plan.actor.spaceId ||
      account.sessionEpoch !== plan.actor.sessionEpoch ||
      account.groupId !== plan.groupId ||
      !(await this.accounts.listGroups()).some(group => group.id === plan.groupId) ||
      !(await this.groups.preinstalls(plan.groupId)).includes(plugin.packageName)
    )
      return 'cancelled'
    const row = (await this.library.list()).find(row => row.packageName === plugin.packageName)
    if (!row || row.removing || row.incompatible || row.stage !== 'available' || row.current?.runtimeRevision !== this.runtimeRevision) return 'cancelled'
    const frozen = plan.dependencies && Object.hasOwn(plan.dependencies, plugin.packageName) ? plan.dependencies[plugin.packageName] : undefined
    if (frozen && nativePluginDependencyPlan(row).identity !== frozen.identity) return 'restart-required'
    return row.current.version === plugin.version &&
      row.current.integrity === plugin.integrity &&
      row.current.artifact === plugin.artifact &&
      row.current.preparationId === plugin.preparationId
      ? 'ready'
      : 'cancelled'
  }
  async delivered(spaceId: string, packageName: string): Promise<boolean> {
    return (await this.records.get(spaceId)).some(row => row.packageName === packageName)
  }
  async incompleteMembers(groupId: string, failures: ReadonlyMap<string, ReadonlySet<string>>): Promise<number> {
    const packages = new Set(await this.groups.preinstalls(groupId))
    let incomplete = 0
    for (const account of await this.accounts.list()) {
      if (account.disabled || account.groupId !== groupId) continue
      for (const name of failures.get(account.spaceId) ?? [])
        if (packages.has(name) && !(await this.delivered(account.spaceId, name))) {
          incomplete++
          break
        }
    }
    return incomplete
  }
}
