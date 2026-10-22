import { preinstallCandidates, type PluginPreinstallPlan } from '../domain/plugin-preinstall.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { PluginGroupConfigurationPort } from '../ports/managed-plugins.js'
import type { PluginInstallationsPort } from '../ports/plugin-installations.js'
import type { PluginPreinstallPlanningPort } from '../ports/plugin-preinstalls.js'

/** Group and delivery eligibility share one checked-library policy at planning and execution. */
export class GroupPluginPreinstalls implements PluginPreinstallPlanningPort {
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get' | 'list' | 'listGroups'>,
    private readonly library: Pick<PluginLibraryStorePort, 'list'>, private readonly groups: Pick<PluginGroupConfigurationPort, 'preinstalls'>,
    private readonly records: Pick<PluginInstallationsPort, 'get'>, private readonly runtimeRevision: string) {}
  plan(username: string, installed: readonly string[]): PluginPreinstallPlan | undefined {
    const account = this.accounts.get(username)
    if (!account || account.disabled || !this.accounts.listGroups().some(group => group.id === account.groupId)) return undefined
    return { actor: { username, spaceId: account.spaceId, sessionEpoch: account.sessionEpoch }, groupId: account.groupId,
      plugins: structuredClone(preinstallCandidates({ account, groupId: account.groupId, packages: this.groups.preinstalls(account.groupId), deliveries: this.records.get(account.spaceId), installed, library: this.library.list(), runtimeRevision: this.runtimeRevision })) }
  }
  current(plan: PluginPreinstallPlan, plugin: PreparedPlugin): boolean {
    const account = this.accounts.get(plan.actor.username)
    if (!account || account.disabled || account.spaceId !== plan.actor.spaceId || account.sessionEpoch !== plan.actor.sessionEpoch || account.groupId !== plan.groupId
      || !this.accounts.listGroups().some(group => group.id === plan.groupId) || !this.groups.preinstalls(plan.groupId).includes(plugin.packageName)) return false
    const row = this.library.list().find(row => row.packageName === plugin.packageName)
    return Boolean(row && !row.removing && !row.incompatible && row.stage === 'available' && row.current?.runtimeRevision === this.runtimeRevision
      && row.current.version === plugin.version && row.current.integrity === plugin.integrity && row.current.artifact === plugin.artifact && row.current.preparationId === plugin.preparationId)
  }
  delivered(spaceId: string, packageName: string): boolean { return this.records.get(spaceId).some(row => row.packageName === packageName) }
  incompleteMembers(groupId: string, failures: ReadonlyMap<string, ReadonlySet<string>>): number {
    const packages = new Set(this.groups.preinstalls(groupId))
    return this.accounts.list().filter(account => !account.disabled && account.groupId === groupId
      && [...(failures.get(account.spaceId) ?? [])].some(name => packages.has(name) && !this.delivered(account.spaceId, name))).length
  }
}
