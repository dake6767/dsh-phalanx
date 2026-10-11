import { ExecutionPreparationFailure } from '../domain/execution-preparation.js'
import { ExecutionFailure } from '../domain/platform-execution.js'
import type { ExecutionConfiguration, ExecutionOwner } from '../domain/platform-execution.js'
import type { PreparedExecution, ExecutionPreparationRecord } from '../domain/execution-preparation.js'
import type { ExecutionConfigurationStorePort, ExecutionOwnersPort } from '../ports/platform-execution.js'
import type { ExecutionPreparationStorePort, ExecutionPreparerPort } from '../ports/execution-preparation.js'
import type { Clock } from '../ports/clock.js'

/** One owner for refresh state, duplicate work, cancellation and last usable artifacts. */
export class ExecutionPreparation {
  private readonly active = new Map<string, { identity: string, controller: AbortController, promise: Promise<void> }>()
  private readonly pending = new Set<Promise<void>>()
  private stopped = false
  private started = false
  private readonly persistenceFailures = new Set<string>()
  constructor(private readonly owners: ExecutionOwnersPort, private readonly configurations: Pick<ExecutionConfigurationStorePort, 'get' | 'list'>,
    private readonly store: ExecutionPreparationStorePort, private readonly preparer: ExecutionPreparerPort, private readonly clock: Clock) {}
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
  async recover(): Promise<void> { await this.preparer.recover(); await this.preparer.collect(this.store.list().flatMap(row => row.artifact ? [row.artifact.id] : [])) }
  start(): void { this.started = true; this.schedule(true) }
  schedule(recovering = false): void { if (!this.started) return; void this.synchronize(recovering).catch(() => { /* persist retains the affected owner until a successful write. */ }) }
  restart(id: string): void { void this.refresh(id).catch(() => { /* persist retains the affected owner until a successful write. */ }) }
  async synchronize(recovering = false): Promise<void> {
    const jobs: Promise<void>[] = []
    for (const row of this.configurations.list()) {
      const owner = this.owners.get(row.owner)
      if (owner && row.configuration.enabled) jobs.push(this.request(owner, row.configuration, recovering && this.store.get(owner.id)?.stage === 'preparing'))
    }
    await Promise.all(jobs)
  }
  refresh(id: string): Promise<void> {
    const owner = this.owners.get(id), configuration = this.configurations.get(id)
    if (!owner || !configuration?.enabled) throw new ExecutionFailure('disabled')
    return this.request(owner, configuration, true)
  }
  async stop(): Promise<void> {
    this.stopped = true
    for (const row of this.active.values()) row.controller.abort()
    await Promise.allSettled(this.pending)
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
    task.promise = this.preparer.prepare(owner, configuration, controller.signal).then(artifact => {
      if (this.active.get(owner.id) !== task || controller.signal.aborted) return
      this.persist(owner.id, { identity, stage: 'ready', updatedAt: this.clock.now(), log: artifact.log, artifact })
    }, error => {
      if (this.active.get(owner.id) !== task || controller.signal.aborted) return
      this.persist(owner.id, { identity, stage: 'failed', updatedAt: this.clock.now(), log: error instanceof ExecutionPreparationFailure ? error.log : 'Preparation failed. Retry after checking the preparation command.', ...(previous?.artifact ? { artifact: previous.artifact } : {}) })
    }).finally(() => { if (this.active.get(owner.id) === task) this.active.delete(owner.id); this.pending.delete(task.promise) })
    this.pending.add(task.promise)
    return task.promise
  }
}
