import type { CommunityStartupStage } from '../domain/admin-contract.js'
import { CommunityRuntimeUnavailableError, type CommunityModelGatewayAccess, type CommunityRuntimePort,
  type CommunityRuntimeStatus, type CommunityUserInstance } from '../ports/community-runtime.js'
import { CommunityRuntimeCleanupError, type CommunityRuntimeDriverPort } from '../ports/community-runtime-driver.js'
import { instanceResourcesApplied, type InstanceResourceLimits } from '../domain/instance-resources.js'

/** One owner for admission, single-instance starts, activity fences and shutdown. */
export class CommunityInstanceLifecycle implements CommunityRuntimePort {
  private readonly running = new Map<string, CommunityUserInstance>()
  private readonly starting = new Map<string, { promise: Promise<CommunityUserInstance>, abort: AbortController, progress: { stage: CommunityStartupStage } }>()
  private readonly draining = new Set<string>()
  private readonly removing = new Map<string, Promise<void>>()
  private readonly maintenance = new Map<string, Promise<void>>()
  private readonly restarting = new Map<string, Promise<CommunityUserInstance>>()
  private readonly reclaiming = new Map<string, Promise<import('../ports/community-runtime.js').CommunityReclaimResult>>()
  private readonly checking = new Map<CommunityUserInstance, Promise<void>>()
  private readonly queued = new Map<string, { origin: string, eligible: () => boolean, current: () => boolean,
    promise: Promise<CommunityUserInstance>, resolve: (instance: CommunityUserInstance) => void, reject: (error: unknown) => void }>()
  private automaticStarts = 0
  private refreshing: Promise<void> | undefined
  private stopped = false
  constructor(private readonly driver: CommunityRuntimeDriverPort,
    private readonly access: (userId: string, publicOriginUrl: string) => CommunityModelGatewayAccess,
    private readonly onReady: (userId: string) => void = () => {}) {}

  async reconcileStartupContainers() {
    if (this.running.size !== 0 || this.starting.size !== 0) throw new Error('Startup reconciliation must precede admission')
    return { adopted: [], swept: await this.driver.rebuild() }
  }
  async waitForMaintenance(userId: string): Promise<void> {
    let pending
    while ((pending = this.maintenance.get(userId) ?? this.reclaiming.get(userId)) !== undefined) await pending
    if (this.stopped) throw this.unavailable('shutdown')
  }
  async ensure(userId: string, publicOriginUrl: string): Promise<CommunityUserInstance> {
    if (this.stopped) throw this.unavailable('shutdown')
    if (this.draining.has(userId)) throw this.unavailable('draining')
    const queued = this.queued.get(userId)
    if (queued) {
      this.queued.delete(userId)
      const remaining = [...this.queued]
      this.queued.clear(); this.queued.set(userId, queued)
      for (const [key, value] of remaining) this.queued.set(key, value)
      return await queued.promise
    }
    const existing = this.starting.get(userId)
    if (existing !== undefined) return await existing.promise
    return await this.launch(userId, publicOriginUrl)
  }
  /** Queue automatic work in the same owner used by foreground admission. */
  queueStart(userId: string, origin: string, eligible: () => boolean, current: () => boolean = () => true): Promise<CommunityUserInstance> {
    if (this.stopped) return Promise.reject(this.unavailable('shutdown'))
    if (this.draining.has(userId)) return Promise.reject(this.unavailable('start-cancelled'))
    const pending = this.queued.get(userId)?.promise ?? this.starting.get(userId)?.promise
    if (pending) return pending
    const active = this.running.get(userId)
    if (active) return Promise.resolve(active)
    let resolve!: (instance: CommunityUserInstance) => void, reject!: (error: unknown) => void
    const promise = new Promise<CommunityUserInstance>((ok, fail) => { resolve = ok; reject = fail })
    this.queued.set(userId, { origin, eligible, current, promise, resolve, reject })
    this.pump()
    return promise
  }
  cancelQueued(userId: string): void {
    const task = this.queued.get(userId)
    if (task) { this.queued.delete(userId); task.reject(this.unavailable('start-cancelled')) }
  }
  private pump(): void {
    while (!this.stopped && this.automaticStarts < 2 && this.queued.size) {
      const [userId, task] = this.queued.entries().next().value!
      this.queued.delete(userId)
      if (this.draining.has(userId) || !task.eligible()) { task.reject(this.unavailable('start-cancelled')); continue }
      this.automaticStarts++
      void (async () => {
        let instance: CommunityUserInstance | undefined, failure: unknown
        try {
          instance = await this.launch(userId, task.origin)
          if (!task.current()) { await this.terminate(userId); throw this.unavailable('start-cancelled') }
        } catch (error) { failure = error }
        finally { this.automaticStarts--; this.pump() }
        if (failure !== undefined) task.reject(failure)
        else task.resolve(instance!)
      })()
    }
  }
  private async launch(userId: string, publicOriginUrl: string): Promise<CommunityUserInstance> {
    const abort = new AbortController()
    const progress: { stage: CommunityStartupStage } = { stage: 'preparing' }
    const promise = this.acquire(userId, publicOriginUrl, abort.signal, stage => { progress.stage = stage })
    const pending = { promise, abort, progress }
    this.starting.set(userId, pending)
    try { return await promise }
    finally { if (this.starting.get(userId) === pending) this.starting.delete(userId) }
  }
  private async acquire(userId: string, publicOriginUrl: string, signal: AbortSignal, progress: (stage: CommunityStartupStage) => void): Promise<CommunityUserInstance> {
    if (this.stopped) throw this.unavailable('shutdown')
    const active = this.running.get(userId)
    if (active !== undefined) return active
    if (signal.aborted) throw this.unavailable('start-cancelled')
    let instance: CommunityUserInstance
    try { instance = await this.driver.start(userId, publicOriginUrl, this.access(userId, publicOriginUrl), signal, progress) }
    catch (error) {
      if (error instanceof CommunityRuntimeCleanupError) {
        this.stopped = true
        for (const userId of this.queued.keys()) this.cancelQueued(userId)
        throw new CommunityRuntimeUnavailableError('shutdown', 'User-space cleanup failed; resolve container removal before restarting', { cause: error })
      }
      if (signal.aborted) throw new CommunityRuntimeUnavailableError('start-cancelled', 'User instance start was cancelled', { cause: error })
      throw error
    }
    if (signal.aborted || this.stopped) {
      await this.driver.stop(instance)
      throw this.unavailable('start-cancelled')
    }
    this.running.set(userId, instance)
    this.onReady(userId)
    return instance
  }
  async applyResources(instance: CommunityUserInstance, limits: InstanceResourceLimits, publicOriginUrl: string, beforeRestart: () => Promise<void>, assertCurrent: () => void) {
    if (this.stopped) throw this.unavailable('shutdown')
    return await this.maintain(instance.userId, async () => {
      const reclamation = this.reclaiming.get(instance.userId)
      if (reclamation) await reclamation
      const assertCarrier = () => {
        if (this.stopped) throw this.unavailable('shutdown')
        if (this.running.get(instance.userId) !== instance) throw this.unavailable('draining')
        assertCurrent()
      }
      assertCarrier()
      const observed = await this.driver.applyResources?.(instance, limits)
      assertCarrier()
      if (observed && instanceResourcesApplied(observed, limits)) return { instance, method: 'updated' as const }
      await beforeRestart()
      assertCarrier()
      await this.remove(instance.userId)
      if (this.stopped) throw this.unavailable('shutdown')
      assertCurrent()
      const replacement = await this.launch(instance.userId, publicOriginUrl)
      if (!replacement.resourceLimits || !instanceResourcesApplied(replacement.resourceLimits, limits)) throw new CommunityRuntimeUnavailableError('startup-unavailable', 'Member resource limits could not be confirmed after restart')
      return { instance: replacement, method: 'restarted' as const }
    })
  }
  /** Failed transfers never replay; only a confirmed, still-current carrier is retired. */
  async check(instance: CommunityUserInstance): Promise<void> {
    if (this.stopped || this.running.get(instance.userId) !== instance) return
    const existing = this.checking.get(instance)
    if (existing !== undefined) return await existing
    const task = (async () => {
      if (!await this.driver.alive(instance)) await this.retire(instance)
    })()
    this.checking.set(instance, task)
    try { await task } finally { this.checking.delete(instance) }
  }
  async refresh(): Promise<void> {
    if (this.stopped) return
    if (this.refreshing !== undefined) return await this.refreshing
    const instances = [...this.running.values()]
    if (!instances.length) return
    const task = (async () => {
      const active = new Set(this.driver.running ? await this.driver.running(instances)
        : (await Promise.all(instances.map(async instance => await this.driver.alive(instance) ? instance : undefined))).filter(instance => instance !== undefined))
      for (const instance of instances) if (!active.has(instance)) await this.retire(instance)
    })()
    this.refreshing = task
    try { await task } finally { this.refreshing = undefined }
  }
  private async retire(instance: CommunityUserInstance): Promise<void> {
    if (this.stopped || this.running.get(instance.userId) !== instance || this.draining.has(instance.userId)) return
    await this.maintain(instance.userId, async () => {
      if (this.running.get(instance.userId) !== instance) return
      await this.driver.stop(instance)
      if (this.running.get(instance.userId) === instance) this.running.delete(instance.userId)
    })
  }
  status(userId: string): CommunityRuntimeStatus {
    const instance = this.running.get(userId)
    if (instance !== undefined) return { state: this.draining.has(userId) ? 'draining' : 'ready', instance }
    const pending = this.starting.get(userId)
    return pending ? { state: 'starting', stage: pending.progress.stage } : this.maintenance.has(userId) || this.queued.has(userId) ? { state: 'starting', stage: 'preparing' } : { state: 'stopped' }
  }
  async restart(userId: string, publicOriginUrl: string): Promise<CommunityUserInstance> {
    if (this.stopped) throw this.unavailable('shutdown')
    const existing = this.restarting.get(userId)
    if (existing !== undefined) return await existing
    const task = this.maintain(userId, async () => {
      await this.remove(userId)
      return await this.launch(userId, publicOriginUrl)
    })
    this.restarting.set(userId, task)
    try { return await task } finally { if (this.restarting.get(userId) === task) this.restarting.delete(userId) }
  }
  async recover(userId: string, publicOriginUrl: string, afterStopped: () => Promise<void>): Promise<CommunityUserInstance> {
    if (this.stopped) throw this.unavailable('shutdown')
    return await this.maintain(userId, async () => {
      await this.remove(userId)
      if (this.stopped) throw this.unavailable('shutdown')
      await afterStopped()
      return await this.launch(userId, publicOriginUrl)
    })
  }
  private async maintain<T>(userId: string, operation: () => Promise<T>): Promise<T> {
    this.cancelQueued(userId)
    this.draining.add(userId)
    const previous = this.maintenance.get(userId) ?? Promise.resolve()
    const task = previous.then(operation)
    const settled = task.then(() => {}, () => {})
    this.maintenance.set(userId, settled)
    try { return await task }
    finally {
      if (this.maintenance.get(userId) === settled) { this.maintenance.delete(userId); this.draining.delete(userId) }
    }
  }
  async terminate(userId: string): Promise<void> {
    const removal = this.removing.get(userId)
    if (removal !== undefined) return await removal
    const task = this.maintain(userId, async () => await this.remove(userId))
    this.removing.set(userId, task)
    try { await task } finally { this.removing.delete(userId) }
  }
  private async remove(userId: string): Promise<void> {
    const reclamation = this.reclaiming.get(userId)
    if (reclamation !== undefined) await reclamation
    const pending = this.starting.get(userId)
    pending?.abort.abort()
    if (pending !== undefined) await pending.promise.catch(() => undefined)
    const instance = this.running.get(userId)
    if (instance !== undefined) { await this.driver.stop(instance); this.running.delete(userId) }
  }
  async reclaim(userId: string, prepare: (instance: CommunityUserInstance) => Promise<boolean>) {
    if (this.stopped) throw this.unavailable('shutdown')
    if (this.draining.has(userId) || this.starting.has(userId)) return 'already-draining' as const
    const instance = this.running.get(userId)
    if (instance === undefined) return 'not-running' as const
    this.draining.add(userId)
    const task = (async () => {
      try {
        if (!await prepare(instance)) return 'busy' as const
        await this.driver.stop(instance); this.running.delete(userId)
        return 'reclaimed' as const
      } finally { if (!this.maintenance.has(userId)) this.draining.delete(userId) }
    })()
    this.reclaiming.set(userId, task)
    try { return await task } finally { this.reclaiming.delete(userId) }
  }
  async stopAll(): Promise<void> {
    this.stopped = true
    for (const userId of this.queued.keys()) this.cancelQueued(userId)
    for (const pending of this.starting.values()) pending.abort.abort()
    await Promise.allSettled([...this.starting.values()].map(pending => pending.promise))
    const operations = await Promise.allSettled([...this.removing.values(), ...this.restarting.values(), ...this.maintenance.values(), ...this.reclaiming.values(), ...this.checking.values(), ...(this.refreshing ? [this.refreshing] : [])])
    const releases = await Promise.allSettled([...this.running].map(async ([userId, instance]) => { await this.driver.detach(instance); this.running.delete(userId) }))
    const failures = [...operations, ...releases].filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (failures.length > 0) throw new AggregateError(failures, 'Some user instances could not finish shutdown')
  }
  private unavailable(reason: 'draining' | 'shutdown' | 'start-cancelled') {
    return new CommunityRuntimeUnavailableError(reason, `User instance is unavailable (${reason})`)
  }
}
