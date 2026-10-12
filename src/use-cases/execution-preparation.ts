import { ExecutionPreparationFailure } from '../domain/execution-preparation.js'
import { ExecutionFailure } from '../domain/platform-execution.js'
import type { ExecutionConfiguration, ExecutionOwner } from '../domain/platform-execution.js'
import type { PreparedExecution, ExecutionPreparationRecord } from '../domain/execution-preparation.js'
import type { ExecutionConfigurationStorePort, ExecutionOwnerInventoryPort } from '../ports/platform-execution.js'
import type { ExecutionPreparationStorePort, ExecutionPreparerPort } from '../ports/execution-preparation.js'
import type { Clock } from '../ports/clock.js'

/** One owner for refresh state, duplicate work, cancellation and last usable artifacts. */
export class ExecutionPreparation {
  private readonly active = new Map<string, { identity: string, controller: AbortController, promise: Promise<void> }>()
  private readonly pending = new Map<Promise<void>, string>()
  private readonly leases = new Map<string, number>()
  private readonly executions = new Set<Promise<unknown>>()
  private collecting = false
  private collection: Promise<void> = Promise.resolve()
  private stopped = false
  private started = false
  private readonly persistenceFailures = new Set<string>()
  constructor(private readonly owners: ExecutionOwnerInventoryPort, private readonly configurations: Pick<ExecutionConfigurationStorePort, 'get' | 'list' | 'retain'>,
    private readonly store: ExecutionPreparationStorePort, private readonly preparer: ExecutionPreparerPort, private readonly clock: Clock, private readonly completed: () => Promise<void> = async () => {}) {}
  view(owner: string): ExecutionPreparationRecord | undefined {
    const record = this.store.get(owner)
    if (this.persistenceFailures.has(owner)) return { ...record, identity: record?.identity ?? '', stage: 'failed', updatedAt: this.clock.now(), log: 'Preparation state could not be saved. Check platform storage and prepare again.' }
    return record
  }
  ready(owner: string): PreparedExecution {
    if (this.persistenceFailures.has(owner)) throw new ExecutionFailure('internal')
    const record = this.store.get(owner)
    if (!record?.artifact || record.stage === 'failed') throw new ExecutionFailure('not-ready')
    return record.artifact
  }
  async recover(): Promise<void> { await this.preparer.recover(); this.prune(); await this.collect() }
  async changed(): Promise<void> {
    this.prune()
    await Promise.allSettled([...this.pending].filter(([, id]) => !this.owners.identities().includes(id)).map(([promise]) => promise))
    await this.collect(); this.schedule()
  }
  async withPrepared<T>(owner: string, run: (artifact: PreparedExecution) => Promise<T>): Promise<T> {
    if (this.stopped) throw new ExecutionFailure('internal')
    const artifact = this.ready(owner)
    this.leases.set(artifact.id, (this.leases.get(artifact.id) ?? 0) + 1)
    const task = (async () => {
      try { return await run(artifact) }
      finally {
        const remaining = this.leases.get(artifact.id)! - 1
        if (remaining) this.leases.set(artifact.id, remaining); else this.leases.delete(artifact.id)
        await this.collect()
      }
    })()
    this.executions.add(task)
    try { return await task } finally { this.executions.delete(task) }
  }
  private prune(): void {
    const ids = this.owners.identities()
    for (const [id, task] of this.active) if (!ids.includes(id)) task.controller.abort()
    this.configurations.retain(ids); this.store.retain(ids)
    for (const id of this.persistenceFailures) if (!ids.includes(id)) this.persistenceFailures.delete(id)
  }
  private collect(): Promise<void> {
    if (this.pending.size) return Promise.resolve()
    const result = this.collection.then(async () => {
      if (this.pending.size) return
      this.collecting = true
      try { await this.preparer.collect([...this.store.list().flatMap(row => row.artifact ? [row.artifact.id] : []), ...this.leases.keys()]) }
      finally { this.collecting = false }
    })
    this.collection = result.catch(() => {}); return result
  }
  start(): void { this.started = true; this.schedule(true) }
  schedule(recovering = false): void { if (!this.started) return; void this.synchronize(recovering).catch(() => { /* persist retains the affected owner until a successful write. */ }) }
  restart(id: string): void { void this.refresh(id).catch(() => { /* persist retains the affected owner until a successful write. */ }) }
  async synchronize(recovering = false): Promise<void> {
    this.prune()
    const jobs: Promise<void>[] = []
    for (const row of this.configurations.list()) {
      const owner = this.owners.get(row.owner)
      if (owner && row.configuration.enabled) jobs.push(this.request(owner, row.configuration, recovering && this.store.get(owner.id)?.stage === 'preparing'))
    }
    await Promise.all(jobs); await this.collect()
  }
  refresh(id: string): Promise<void> {
    const owner = this.owners.get(id), configuration = this.configurations.get(id)
    if (!owner || !configuration?.enabled) throw new ExecutionFailure('disabled')
    return this.request(owner, configuration, true)
  }
  async stop(): Promise<void> {
    this.stopped = true
    for (const row of this.active.values()) row.controller.abort()
    await Promise.allSettled([...this.pending.keys(), ...this.executions]); await this.collection
  }
  private persist(owner: string, value: ExecutionPreparationRecord): void {
    try { this.store.save(owner, value); this.persistenceFailures.delete(owner) }
    catch (error) { this.persistenceFailures.add(owner); throw error }
  }
  private request(owner: ExecutionOwner, configuration: ExecutionConfiguration, force: boolean): Promise<void> {
    if (this.stopped) return Promise.resolve()
    const identity = this.preparer.identity(owner, configuration), previous = this.store.get(owner.id), current = this.active.get(owner.id)
    if (current?.identity === identity) return current.promise
    if (!force && !current && previous?.identity === identity) return Promise.resolve()
    current?.controller.abort()
    const controller = new AbortController()
    this.persist(owner.id, { identity, stage: 'preparing', updatedAt: this.clock.now(), log: '', ...(previous?.artifact ? { artifact: previous.artifact } : {}) })
    const task = { identity, controller, promise: Promise.resolve() }
    this.active.set(owner.id, task)
    const prepare = () => { controller.signal.throwIfAborted(); return this.preparer.prepare(owner, configuration, controller.signal) }
    task.promise = (this.collecting ? this.collection.then(prepare) : prepare()).then(artifact => {
      if (this.active.get(owner.id) !== task || controller.signal.aborted) return
      this.persist(owner.id, { identity, stage: 'ready', updatedAt: this.clock.now(), log: artifact.log, artifact })
    }, error => {
      if (this.active.get(owner.id) !== task || controller.signal.aborted) return
      this.persist(owner.id, { identity, stage: 'failed', updatedAt: this.clock.now(), log: error instanceof ExecutionPreparationFailure ? error.log : 'Preparation failed. Retry after checking the preparation command.', ...(previous?.artifact ? { artifact: previous.artifact } : {}) })
    }).finally(async () => { if (this.active.get(owner.id) === task) this.active.delete(owner.id); this.pending.delete(task.promise); await this.collect(); await this.completed() })
    this.pending.set(task.promise, owner.id)
    return task.promise
  }
}
