import type { CommunityMarketPreinstallFailure } from '../domain/plugin-admin-contract.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
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
  private readonly firstEntries = new WeakMap<CommunityUserInstance, { work: Promise<void>; complete: boolean }>()
  private readonly unapplied = new WeakMap<CommunityUserInstance, Set<string>>()
  private readonly retries = new Map<string, Promise<void>>()
  private readonly active = new Set<Promise<void>>()
  private readonly failures = new Map<string, Set<string>>()
  private stopping = false
  constructor(
    private readonly policy: GroupPluginPreinstalls,
    private readonly jobs: Pick<MemberNativePluginJobs, 'preinstall' | 'cancelSpace'>,
    private readonly runtime: Pick<CommunityRuntimePort, 'status'>,
    private readonly records: Pick<PluginInstallationsPort, 'resetForSpace'>,
  ) {}
  ready(instance: CommunityUserInstance, origin: URL): void {
    const plan = instance.preinstallPlan
    if (this.stopping || !plan || this.dispatched.has(instance) || this.firstEntryPending(instance)) return
    this.dispatched.add(instance)
    const required = new Set(plan.firstEntry ?? [])
    void this.track(
      this.deliver(
        instance,
        plan,
        origin,
        plan.plugins.filter(plugin => !required.has(plugin.packageName)),
      ),
    )
  }
  firstEntryPending(instance: CommunityUserInstance): boolean {
    return Boolean(instance.preinstallPlan?.firstEntry?.length && !this.firstEntries.get(instance)?.complete)
  }
  awaitFirstEntry(instance: CommunityUserInstance, origin: URL): Promise<void> {
    const plan = instance.preinstallPlan
    if (this.stopping || !plan?.firstEntry?.length) return Promise.resolve()
    const existing = this.firstEntries.get(instance)
    if (existing) return existing.work
    const required = new Set(plan.firstEntry)
    const state = { work: Promise.resolve(), complete: false }
    state.work = this.track(
      this.deliver(
        instance,
        plan,
        origin,
        plan.plugins.filter(plugin => required.has(plugin.packageName)),
      ),
    ).then(() => {
      state.complete = true
      this.ready(instance, origin)
    })
    this.firstEntries.set(instance, state)
    return state.work
  }
  private track(work: Promise<void>): Promise<void> {
    const settled = work.catch(() => {
      console.warn('Preinstall batch could not finish; retained successful deliveries')
    })
    this.active.add(settled)
    void settled.then(() => {
      this.active.delete(settled)
    })
    return settled
  }
  private async current(instance: CommunityUserInstance, plan: PluginPreinstallPlan, plugin: PreparedPlugin) {
    const allowed = await this.policy.current(plan, plugin)
    const state = this.runtime.status(instance.userId)
    return !this.stopping && (state.state === 'ready' || state.state === 'draining') && state.instance === instance ? allowed : 'cancelled'
  }
  private async deliver(instance: CommunityUserInstance, plan: PluginPreinstallPlan, origin: URL, plugins: readonly PreparedPlugin[]): Promise<void> {
    for (const plugin of plugins) {
      const readiness = await this.current(instance, plan, plugin)
      if (readiness === 'cancelled') continue
      if (await this.policy.delivered(plan.actor.spaceId, plugin.packageName)) continue
      let failed = readiness === 'restart-required' || plan.blocked?.includes(plugin.packageName) === true
      if (!failed) {
        try {
          const outcome = await this.jobs.preinstall(plan.actor, plugin, instance, origin, async () => (await this.current(instance, plan, plugin)) === 'ready')
          failed = outcome === 'failed' || (outcome === 'skipped' && this.failures.get(plan.actor.spaceId)?.has(plugin.packageName) === true)
          if (outcome === 'restart-required') {
            const pending = this.unapplied.get(instance) ?? new Set<string>()
            pending.add(plugin.packageName)
            this.unapplied.set(instance, pending)
          }
        } catch {
          failed = true
        }
      }
      const latest = await this.current(instance, plan, plugin)
      if (latest === 'cancelled') continue
      const failures = this.failures.get(plan.actor.spaceId) ?? new Set<string>()
      if (failed || latest === 'restart-required') failures.add(plugin.packageName)
      else failures.delete(plugin.packageName)
      if (failures.size) this.failures.set(plan.actor.spaceId, failures)
      else this.failures.delete(plan.actor.spaceId)
    }
  }
  async listFailures(actor: CommunityAccountActor, instance: CommunityUserInstance): Promise<readonly CommunityMarketPreinstallFailure[]> {
    const plan = instance.preinstallPlan
    if (!plan || !this.sameMember(actor, plan.actor)) return []
    const failures = this.failures.get(actor.spaceId)
    const unapplied = this.unapplied.get(instance)
    if (!failures?.size && !unapplied?.size) return []
    const visible = await Promise.all(
      plan.plugins.map(async plugin => {
        const name = plugin.packageName
        if (!(failures?.has(name) || unapplied?.has(name))) return undefined
        const readiness = await this.current(instance, plan, plugin)
        if (readiness === 'cancelled') return undefined
        if (unapplied?.has(name)) return { packageName: name, restartRequired: true }
        if (await this.policy.delivered(actor.spaceId, name)) return undefined
        return { packageName: name, restartRequired: readiness === 'restart-required' || plan.blocked?.includes(name) === true }
      }),
    )
    return visible.filter(row => row !== undefined)
  }
  async retry(actor: CommunityAccountActor, instance: CommunityUserInstance, packageName: string, origin: URL): Promise<void> {
    const plan = instance.preinstallPlan
    const plugin = plan?.plugins.find(row => row.packageName === packageName)
    if (!plan || !plugin || !this.sameMember(actor, plan.actor) || plan.blocked?.includes(packageName)) return
    const key = actor.spaceId + '\0' + packageName
    const previous = this.retries.get(key)
    if (previous) return await previous
    if (!(await this.listFailures(actor, instance)).some(row => row.packageName === packageName && !row.restartRequired)) return
    const current = this.retries.get(key)
    if (current) return await current
    const work = this.track(this.deliver(instance, plan, origin, [plugin])).finally(() => this.retries.delete(key))
    this.retries.set(key, work)
    return await work
  }
  private sameMember(a: CommunityAccountActor, b: CommunityAccountActor) {
    return a.username === b.username && a.spaceId === b.spaceId && a.sessionEpoch === b.sessionEpoch
  }
  async incompleteMembers(groupId: string): Promise<number> {
    return await this.policy.incompleteMembers(groupId, this.failures)
  }
  async beforeReset(spaceId: string): Promise<void> {
    await this.jobs.cancelSpace(spaceId)
  }
  async afterReset(spaceId: string): Promise<void> {
    await this.records.resetForSpace(spaceId)
    this.failures.delete(spaceId)
  }
  async drain(): Promise<void> {
    await Promise.allSettled([...this.active])
  }
  async stop(): Promise<void> {
    this.stopping = true
    await this.drain()
  }
}
