import { CommunityRuntimeUnavailableError, type CommunityModelGatewayAccess, type CommunityRuntimePort,
  type CommunityRuntimeStatus, type CommunityUserInstance } from '../ports/community-runtime.js'
import { CommunityRuntimeCleanupError, type CommunityRuntimeDriverPort } from '../ports/community-runtime-driver.js'

/** One owner for admission, single-instance starts, activity fences and shutdown. */
export class CommunityInstanceLifecycle implements CommunityRuntimePort {
  private readonly running = new Map<string, CommunityUserInstance>()
  private readonly starting = new Map<string, { promise: Promise<CommunityUserInstance>, abort: AbortController }>()
  private readonly draining = new Set<string>()
  private readonly removing = new Map<string, Promise<void>>()
  private readonly reclaiming = new Map<string, Promise<import('../ports/community-runtime.js').CommunityReclaimResult>>()
  private stopped = false
  constructor(private readonly driver: CommunityRuntimeDriverPort,
    private readonly access: (userId: string, authority: string) => CommunityModelGatewayAccess) {}

  async reconcileStartupContainers() {
    if (this.running.size !== 0 || this.starting.size !== 0) throw new Error('Startup reconciliation must precede admission')
    return { adopted: [], swept: await this.driver.rebuild() }
  }
  async ensure(userId: string, authority: string): Promise<CommunityUserInstance> {
    if (this.stopped) throw this.unavailable('shutdown')
    if (this.draining.has(userId)) throw this.unavailable('draining')
    const existing = this.starting.get(userId)
    if (existing !== undefined) return await existing.promise
    const abort = new AbortController()
    const promise = this.acquire(userId, authority, abort.signal)
    const pending = { promise, abort }
    this.starting.set(userId, pending)
    try { return await promise }
    finally { if (this.starting.get(userId) === pending) this.starting.delete(userId) }
  }
  private async acquire(userId: string, authority: string, signal: AbortSignal): Promise<CommunityUserInstance> {
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
    try { instance = await this.driver.start(userId, authority, this.access(userId, authority), signal) }
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
    return { state: this.starting.has(userId) ? 'starting' : 'stopped' }
  }
  async terminate(userId: string): Promise<void> {
    const removal = this.removing.get(userId)
    if (removal !== undefined) return await removal
    const task = this.remove(userId)
    this.removing.set(userId, task)
    try { await task } finally { this.removing.delete(userId) }
  }
  private async remove(userId: string): Promise<void> {
    const reclamation = this.reclaiming.get(userId)
    if (reclamation !== undefined) await reclamation
    this.draining.add(userId)
    try {
      const pending = this.starting.get(userId)
      pending?.abort.abort()
      if (pending !== undefined) await pending.promise.catch(() => undefined)
      const instance = this.running.get(userId)
      if (instance !== undefined) { await this.driver.stop(instance); this.running.delete(userId) }
    } finally { this.draining.delete(userId) }
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
      } finally { this.draining.delete(userId) }
    })()
    this.reclaiming.set(userId, task)
    try { return await task } finally { this.reclaiming.delete(userId) }
  }
  async stopAll(): Promise<void> {
    this.stopped = true
    for (const pending of this.starting.values()) pending.abort.abort()
    await Promise.allSettled([...this.starting.values()].map(pending => pending.promise))
    const operations = await Promise.allSettled([...this.removing.values(), ...this.reclaiming.values()])
    const releases = await Promise.allSettled([...this.running].map(async ([userId, instance]) => { await this.driver.detach(instance); this.running.delete(userId) }))
    const failures = [...operations, ...releases].filter(result => result.status === 'rejected').map(result => result.reason as unknown)
    if (failures.length > 0) throw new AggregateError(failures, 'Some user instances could not finish shutdown')
  }
  private unavailable(reason: 'draining' | 'shutdown' | 'start-cancelled') {
    return new CommunityRuntimeUnavailableError(reason, `User instance is unavailable (${reason})`)
  }
}
