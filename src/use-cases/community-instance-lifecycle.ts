import { CommunityRuntimeUnavailableError, type CommunityModelGatewayAccess, type CommunityRuntimePort,
  type CommunityRuntimeStatus, type CommunityUserInstance } from '../ports/community-runtime.js'
import { CommunityRuntimeCleanupError, type CommunityRuntimeDriverPort } from '../ports/community-runtime-driver.js'

/** One owner for admission, single-instance starts, activity fences and shutdown. */
export class CommunityInstanceLifecycle implements CommunityRuntimePort {
  private readonly running = new Map<string, CommunityUserInstance>()
  private readonly starting = new Map<string, { promise: Promise<CommunityUserInstance>, abort: AbortController }>()
  private readonly draining = new Set<string>()
  private readonly removing = new Map<string, Promise<void>>()
  private readonly maintenance = new Map<string, Promise<void>>()
  private readonly restarting = new Map<string, Promise<CommunityUserInstance>>()
  private readonly reclaiming = new Map<string, Promise<import('../ports/community-runtime.js').CommunityReclaimResult>>()
  private stopped = false
  constructor(private readonly driver: CommunityRuntimeDriverPort,
    private readonly access: (userId: string, publicOriginUrl: string) => CommunityModelGatewayAccess) {}

  async reconcileStartupContainers() {
    if (this.running.size !== 0 || this.starting.size !== 0) throw new Error('Startup reconciliation must precede admission')
    return { adopted: [], swept: await this.driver.rebuild() }
  }
  async ensure(userId: string, publicOriginUrl: string): Promise<CommunityUserInstance> {
    if (this.stopped) throw this.unavailable('shutdown')
    if (this.draining.has(userId)) throw this.unavailable('draining')
    const existing = this.starting.get(userId)
    if (existing !== undefined) return await existing.promise
    return await this.launch(userId, publicOriginUrl)
  }
  private async launch(userId: string, publicOriginUrl: string): Promise<CommunityUserInstance> {
    const abort = new AbortController()
    const promise = this.acquire(userId, publicOriginUrl, abort.signal)
    const pending = { promise, abort }
    this.starting.set(userId, pending)
    try { return await promise }
    finally { if (this.starting.get(userId) === pending) this.starting.delete(userId) }
  }
  private async acquire(userId: string, publicOriginUrl: string, signal: AbortSignal): Promise<CommunityUserInstance> {
    if (this.stopped) throw this.unavailable('shutdown')
    const active = this.running.get(userId)
    if (active !== undefined) {
      if (await this.driver.alive(active)) {
        if (signal.aborted) throw this.unavailable('start-cancelled')
        return active
      }
      await this.driver.stop(active)
      this.running.delete(userId)
    }
    if (signal.aborted) throw this.unavailable('start-cancelled')
    let instance: CommunityUserInstance
    try { instance = await this.driver.start(userId, publicOriginUrl, this.access(userId, publicOriginUrl), signal) }
    catch (error) {
      if (error instanceof CommunityRuntimeCleanupError) {
        this.stopped = true
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
    return instance
  }
  status(userId: string): CommunityRuntimeStatus {
    const instance = this.running.get(userId)
    if (instance !== undefined) return { state: this.draining.has(userId) ? 'draining' : 'ready', instance }
    return { state: this.starting.has(userId) || this.maintenance.has(userId) ? 'starting' : 'stopped' }
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
    for (const pending of this.starting.values()) pending.abort.abort()
    await Promise.allSettled([...this.starting.values()].map(pending => pending.promise))
    const operations = await Promise.allSettled([...this.removing.values(), ...this.restarting.values(), ...this.maintenance.values(), ...this.reclaiming.values()])
    const releases = await Promise.allSettled([...this.running].map(async ([userId, instance]) => { await this.driver.detach(instance); this.running.delete(userId) }))
    const failures = [...operations, ...releases].filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (failures.length > 0) throw new AggregateError(failures, 'Some user instances could not finish shutdown')
  }
  private unavailable(reason: 'draining' | 'shutdown' | 'start-cancelled') {
    return new CommunityRuntimeUnavailableError(reason, `User instance is unavailable (${reason})`)
  }
}
