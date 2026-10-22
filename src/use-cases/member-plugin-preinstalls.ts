import type { PluginPreinstallPlan } from '../domain/plugin-preinstall.js'
import type { PreparedPlugin } from '../domain/plugin-library.js'
import type { CommunityRuntimePort, CommunityUserInstance } from '../ports/community-runtime.js'
import type { PluginInstallationsPort } from '../ports/plugin-installations.js'
import type { PluginPreinstallResetPort } from '../ports/plugin-preinstalls.js'
import type { GroupPluginPreinstalls } from './group-plugin-preinstalls.js'
import type { MemberNativePluginJobs } from './member-native-plugin-jobs.js'

/** Ready carriers get one asynchronous batch; failures wait for their next startup. */
export class MemberPluginPreinstalls implements PluginPreinstallResetPort {
  private readonly dispatched = new WeakSet<CommunityUserInstance>()
  private readonly active = new Set<Promise<void>>()
  private readonly failures = new Map<string, Set<string>>()
  private stopping = false
  constructor(private readonly policy: GroupPluginPreinstalls, private readonly jobs: Pick<MemberNativePluginJobs, 'preinstall' | 'cancelSpace'>,
    private readonly runtime: Pick<CommunityRuntimePort, 'status'>, private readonly records: Pick<PluginInstallationsPort, 'clearPreinstalls'>) {}
  ready(instance: CommunityUserInstance, origin: URL): void {
    if (this.stopping || !instance.preinstallPlan || this.dispatched.has(instance)) return
    this.dispatched.add(instance)
    const work = this.deliver(instance, instance.preinstallPlan, origin)
    this.active.add(work)
    void work.catch(() => { console.warn('Preinstall batch could not finish; retained successful deliveries') }).finally(() => this.active.delete(work))
  }
  private current(instance: CommunityUserInstance, plan: PluginPreinstallPlan, plugin: PreparedPlugin): boolean {
    const state = this.runtime.status(instance.userId)
    return !this.stopping && (state.state === 'ready' || state.state === 'draining') && state.instance === instance && this.policy.current(plan, plugin)
  }
  private async deliver(instance: CommunityUserInstance, plan: PluginPreinstallPlan, origin: URL): Promise<void> {
    for (const plugin of plan.plugins) {
      if (!this.current(instance, plan, plugin)) continue
      if (this.policy.delivered(plan.actor.spaceId, plugin.packageName)) continue
      let failed = plan.blocked?.includes(plugin.packageName) === true
      if (!failed) {
        try { failed = await this.jobs.preinstall(plan.actor, plugin, instance, origin, () => this.current(instance, plan, plugin)) === 'failed' }
        catch { failed = this.current(instance, plan, plugin) }
      }
      if (!this.current(instance, plan, plugin)) continue
      const failures = this.failures.get(plan.actor.spaceId) ?? new Set<string>()
      if (failed) failures.add(plugin.packageName)
      else failures.delete(plugin.packageName)
      if (failures.size) this.failures.set(plan.actor.spaceId, failures)
      else this.failures.delete(plan.actor.spaceId)
    }
  }
  incompleteMembers(groupId: string): number { return this.policy.incompleteMembers(groupId, this.failures) }
  async beforeReset(spaceId: string): Promise<void> { await this.jobs.cancelSpace(spaceId) }
  afterReset(spaceId: string): void { this.records.clearPreinstalls(spaceId); this.failures.delete(spaceId) }
  async drain(): Promise<void> { await Promise.allSettled([...this.active]) }
  async stop(): Promise<void> { this.stopping = true; await this.drain() }
}
