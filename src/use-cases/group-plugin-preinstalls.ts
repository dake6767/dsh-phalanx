import { preinstallCandidates, type PluginPreinstallPlan } from '../domain/plugin-preinstall.js'
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
  ) {}
  async plan(username: string, installed: readonly string[]): Promise<PluginPreinstallPlan | undefined> {
    const account = await this.accounts.get(username)
    if (!account || account.disabled || !(await this.accounts.listGroups()).some(group => group.id === account.groupId)) return undefined
    return {
      actor: { username, spaceId: account.spaceId, sessionEpoch: account.sessionEpoch },
      groupId: account.groupId,
      plugins: structuredClone(
        preinstallCandidates({
          account,
          groupId: account.groupId,
          packages: await this.groups.preinstalls(account.groupId),
          deliveries: await this.records.get(account.spaceId),
          installed,
          library: await this.library.list(),
          runtimeRevision: this.runtimeRevision,
        }),
      ),
    }
  }
  async current(plan: PluginPreinstallPlan, plugin: PreparedPlugin): Promise<boolean> {
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
      return false
    const row = (await this.library.list()).find(row => row.packageName === plugin.packageName)
    return Boolean(
      row &&
      !row.removing &&
      !row.incompatible &&
      row.stage === 'available' &&
      row.current?.runtimeRevision === this.runtimeRevision &&
      row.current.version === plugin.version &&
      row.current.integrity === plugin.integrity &&
      row.current.artifact === plugin.artifact &&
      row.current.preparationId === plugin.preparationId,
    )
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
