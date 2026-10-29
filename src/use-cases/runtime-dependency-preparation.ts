import { setTimeout as delay } from 'node:timers/promises'
import { BusinessRuleError } from '../domain/business-error.js'
import { PlatformDatabaseError } from '../domain/platform-database.js'
import { runtimeConflicts, runtimeDefinition } from '../domain/runtime-dependency-record.js'
import { RuntimeDependencyPreparationFailure, type RuntimeDependency, type RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { Clock } from '../ports/clock.js'
import type { RuntimeDependencyPreparerPort, RuntimeDependencyReferencesPort, RuntimeDependencyStorePort } from '../ports/runtime-dependencies.js'

/** Sole owner of active preparations, queued retries, retained versions and collection. */
export class RuntimeDependencyPreparation {
  private readonly active = new Map<
    string,
    { controller: AbortController; promise: Promise<void>; superseded: boolean; starting: Promise<void>; publishing: boolean }
  >()
  private readonly removing = new Set<string>()
  private readonly retries = new Map<string, Promise<void>>()
  private readonly leases = new Map<string, number>()
  private readonly executions = new Set<Promise<unknown>>()
  private staging = 0
  private collection: Promise<void> = Promise.resolve()
  stopped = false
  started = false
  constructor(
    private readonly store: RuntimeDependencyStorePort,
    private readonly preparer: RuntimeDependencyPreparerPort,
    private readonly clock: Clock,
    private readonly references: RuntimeDependencyReferencesPort,
    private readonly changed: () => Promise<void>,
  ) {}
  preparing(names: readonly string[]): boolean {
    return names.some(name => this.active.has(name) || this.retries.has(name) || this.removing.has(name))
  }
  async start(): Promise<void> {
    if (this.stopped) return
    this.started = true
    for (const row of await this.store.list()) {
      const previous = row.preparationIdentity ?? row.current?.identity
      if (!previous || previous !== this.preparer.identity(runtimeDefinition(row))) void this.request(row).catch(() => {})
    }
  }
  async withPreparedVersion<T>(prepare: () => Promise<RuntimeDependencyVersion>, run: (version: RuntimeDependencyVersion) => Promise<T>): Promise<T> {
    if (this.stopped) throw new BusinessRuleError('conflict', 'Platform is stopping.', 'runtime-dependency-unavailable')
    this.staging++
    const task = (async () => {
      let preparing = true,
        release: (() => void) | undefined
      try {
        // An already running collector finishes before the new artifact can appear.
        await this.collection
        const version = await prepare()
        release = this.lease([version])
        this.staging--
        preparing = false
        return await run(version)
      } finally {
        await this.collection
        if (preparing) this.staging--
        release?.()
        await this.collectAfterLease()
      }
    })()
    this.executions.add(task)
    try {
      return await task
    } finally {
      this.executions.delete(task)
    }
  }
  private lease(versions: readonly RuntimeDependencyVersion[]): () => void {
    for (const version of versions) this.leases.set(version.id, (this.leases.get(version.id) ?? 0) + 1)
    return () => {
      for (const version of versions) {
        const remaining = this.leases.get(version.id)! - 1
        if (remaining) this.leases.set(version.id, remaining)
        else this.leases.delete(version.id)
      }
    }
  }
  async withVersions<T>(versions: readonly RuntimeDependencyVersion[], run: (versions: readonly RuntimeDependencyVersion[]) => Promise<T>): Promise<T> {
    const release = this.lease(versions)
    const task = (async () => {
      try {
        return await run(versions)
      } finally {
        await this.collection
        release()
        await this.collectAfterLease()
      }
    })()
    this.executions.add(task)
    try {
      return await task
    } finally {
      this.executions.delete(task)
    }
  }
  async recover(): Promise<void> {
    await this.preparer.recover()
    for (const row of await this.store.list())
      if (row.retryPending || row.stage === 'preparing' || row.stage === 'validating')
        await this.store.save({
          ...row,
          retryPending: false,
          stage: 'failed',
          failureCode: 'interrupted',
          updatedAt: this.clock.now(),
          log: row.log + '\nPreparation was interrupted. Prepare again to retry.',
        })
    await this.collect()
  }
  async stop(): Promise<void> {
    this.stopped = true
    for (const task of this.active.values()) task.controller.abort()
    await Promise.allSettled([...this.active.values()].map(task => task.promise))
    await Promise.allSettled(this.retries.values())
    await Promise.allSettled(this.executions)
    await this.collection
  }
  request(row: RuntimeDependency): Promise<void> {
    if (this.removing.has(row.name)) return Promise.reject(new DOMException('Dependency was removed.', 'AbortError'))
    if (this.stopped) return Promise.reject(new BusinessRuleError('conflict', 'Platform is stopping.', 'runtime-dependency-unavailable'))
    const retrying = this.retries.get(row.name)
    if (retrying) return retrying
    const existing = this.active.get(row.name)
    if (existing) {
      if (!existing.publishing || (row.stage !== 'ready' && row.stage !== 'failed')) return existing.promise
      const marking = Promise.resolve().then(async () => {
        const current = await this.require(row.name)
        await this.store.save({ ...current, retryPending: true })
      })
      const queued = Promise.all([existing.promise, marking])
        .then(async () => {
          if (this.retries.get(row.name) === queued) this.retries.delete(row.name)
          existing.controller.signal.throwIfAborted()
          const current = (await this.store.list()).find(item => item.name === row.name)
          if (!current || this.removing.has(row.name)) throw new DOMException('Dependency was removed.', 'AbortError')
          return this.request(current)
        })
        .finally(async () => {
          if (this.retries.has(row.name) && this.retries.get(row.name) !== queued) return
          const pending = (await this.store.list()).find(item => item.name === row.name)
          if (pending?.retryPending)
            await this.store.save({
              ...pending,
              retryPending: false,
              stage: 'failed',
              failureCode: 'interrupted',
              updatedAt: this.clock.now(),
              log: pending.log + '\nPreparation was interrupted. Prepare again to retry.',
            })
          if (this.retries.get(row.name) === queued) this.retries.delete(row.name)
        })
      this.retries.set(row.name, queued)
      void queued.catch(() => {})
      return queued
    }
    let started!: () => void, startFailed!: (error: unknown) => void
    const starting = new Promise<void>((resolve, reject) => {
      started = resolve
      startFailed = reject
    })
    void starting.catch(() => {})
    const task: {
      controller: AbortController
      superseded: boolean
      promise: Promise<void>
      starting: Promise<void>
      publishing: boolean
      identity?: string
      claimed: boolean
    } = {
      controller: new AbortController(),
      superseded: false,
      promise: Promise.resolve(),
      starting,
      publishing: false,
      claimed: false,
    }
    const owns = (current: RuntimeDependency) => {
      if (task.claimed && current.preparationIdentity !== task.identity) {
        task.superseded = true
        task.controller.abort()
      }
      return !task.superseded
    }
    task.promise = Promise.resolve()
      .then(async () => {
        await this.collection
        task.controller.signal.throwIfAborted()
        const current = await this.require(row.name)
        task.controller.signal.throwIfAborted()
        const definition = runtimeDefinition(current)
        task.identity = this.preparer.identity(definition)
        const { failureCode, retryPending, ...retry } = current
        void failureCode
        void retryPending
        await this.store.save({
          ...retry,
          preparationIdentity: task.identity,
          stage: 'preparing',
          updatedAt: this.clock.now(),
          log: '',
          checks: [],
        })
        task.claimed = true
        started()
        task.controller.signal.throwIfAborted()
        return this.preparer.prepare(
          definition,
          async (log, checks) => {
            task.controller.signal.throwIfAborted()
            const progress = await this.require(row.name)
            if (!owns(progress)) throw new DOMException('Preparation was replaced.', 'AbortError')
            task.controller.signal.throwIfAborted()
            await this.store.save({
              ...progress,
              stage: checks ? 'validating' : 'preparing',
              log,
              checks: checks ?? progress.checks,
              updatedAt: this.clock.now(),
            })
          },
          task.controller.signal,
        )
      })
      .then(async version => {
        if (task.superseded) return
        task.controller.signal.throwIfAborted()
        const conflict = (await this.store.list())
          .filter(
            other =>
              other.name !== row.name && other.name !== row.replaces && other.replaces !== row.name && !(row.replaces && other.replaces === row.replaces),
          )
          .flatMap(other => runtimeConflicts(version, other))
        if (conflict.length)
          throw new RuntimeDependencyPreparationFailure('command-conflict', `Command names conflict with ${conflict.join(', ')}.`, [
            ...version.checks,
            { kind: 'commands', passed: false, detail: conflict.join(', ') },
          ])
        const current = { ...(await this.require(row.name)) }
        if (!owns(current)) return
        task.controller.signal.throwIfAborted()
        delete current.failureCode
        await this.store.save({
          ...current,
          stage: 'ready',
          current: version,
          ...(current.current ? { previous: current.current } : {}),
          checks: version.checks,
          log: version.log,
          updatedAt: this.clock.now(),
        })
        task.publishing = true
        try {
          for (;;) {
            task.controller.signal.throwIfAborted()
            const latest = await this.require(row.name)
            if (!owns(latest) || latest.current?.id !== version.id) return
            try {
              await this.changed()
              break
            } catch (error) {
              if (!(error instanceof PlatformDatabaseError) || error.code !== 'unavailable') throw error
              // Another preparation may invalidate the shared readiness view.
              // Keep this committed version and its busy lease while it refreshes.
              await delay(250, undefined, { signal: task.controller.signal, ref: false })
            }
          }
        } catch (error) {
          // Shutdown cancels only publication of an already committed version.
          // Startup rebuilds projections from these ready facts.
          if (task.superseded || (this.stopped && task.controller.signal.aborted)) return
          const latest = await this.require(row.name)
          if (task.superseded || latest.current?.id !== version.id || latest.preparationIdentity !== current.preparationIdentity) return
          const { current: published, previous: prior, ...kept } = latest
          void published
          void prior
          await this.store.save({
            ...kept,
            ...(current.current ? { current: current.current } : {}),
            ...(current.previous ? { previous: current.previous } : {}),
            stage: 'validating',
            checks: version.checks,
            log: version.log,
            updatedAt: this.clock.now(),
          })
          await this.changed()
          throw error
        }
      })
      .catch(async error => {
        startFailed(error)
        if (task.superseded) return
        const current = (await this.store.list()).find(item => item.name === row.name)
        if (!current || !owns(current)) return
        const failure =
          error instanceof RuntimeDependencyPreparationFailure
            ? error
            : new RuntimeDependencyPreparationFailure(
                task.controller.signal.aborted ? 'interrupted' : 'prepare-failed',
                task.controller.signal.aborted
                  ? 'Preparation was interrupted. Prepare again to retry.'
                  : 'Preparation could not finish. Check the command and platform storage.',
              )
        await this.store.save({
          ...current,
          stage: 'failed',
          failureCode: failure.code,
          checks: failure.checks.length ? failure.checks : current.checks,
          log: current.log + '\n' + failure.log,
          updatedAt: this.clock.now(),
        })
        task.publishing = true
        await this.changed()
      })
      .finally(async () => {
        if (this.active.get(row.name) === task) this.active.delete(row.name)
        await this.collect()
      })
    this.active.set(row.name, task)
    void task.promise.catch(() => {})
    return task.promise
  }
  private async collectAfterLease(): Promise<void> {
    try {
      await this.collect()
    } catch {
      console.warn('Runtime artifact collection deferred; the next collection will retry.')
    }
  }
  collect(): Promise<void> {
    const next = this.collection.then(async () => {
      if (this.active.size || this.staging) return
      const rows = await this.store.list(),
        references = (await this.references.retained?.()) ?? []
      if (this.active.size || this.staging) return
      await this.preparer.collect([
        ...rows.flatMap(row => [row.current?.id, row.previous?.id].filter((id): id is string => !!id)),
        ...this.leases.keys(),
        ...references,
      ])
    })
    this.collection = next.catch(() => {})
    return next
  }
  private async require(name: string): Promise<RuntimeDependency> {
    const row = (await this.store.list()).find(item => item.name === name)
    if (!row) throw new BusinessRuleError('missing', 'Runtime dependency is unavailable.', 'runtime-dependency-unavailable')
    return row
  }
  activePromise(name: string): Promise<void> | undefined {
    return this.active.get(name)?.promise
  }
  starting(name: string): Promise<void> | undefined {
    return this.active.get(name)?.starting
  }
  supersede(name: string): void {
    const task = this.active.get(name)
    if (task) {
      task.superseded = true
      task.controller.abort()
    }
  }

  async withRemoval(name: string, operation: () => Promise<void>): Promise<void> {
    if (this.removing.has(name)) throw new BusinessRuleError('conflict', 'Runtime dependency is being removed.', 'runtime-dependency-unavailable')
    this.removing.add(name)
    try {
      await operation()
    } finally {
      this.removing.delete(name)
    }
  }
  async cancel(name: string): Promise<void> {
    const active = this.active.get(name)
    active?.controller.abort()
    await active?.promise
    await Promise.allSettled(this.retries.has(name) ? [this.retries.get(name)!] : [])
  }
}
