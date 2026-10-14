import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityRuntimeDependencyInput, CommunityRuntimeDependencyView } from '../domain/admin-contract.js'
import { runtimeDependencyInput, RuntimeDependencyPreparationFailure, type RuntimeDependency, type RuntimeDependencySource } from '../domain/runtime-dependency.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { RuntimeDependencyStorePort, RuntimeDependencyPreparerPort, RuntimeDependencyReferencesPort } from '../ports/runtime-dependencies.js'
import type { Clock } from '../ports/clock.js'

/** Sole writer of dependency definitions, preparation progress and usable version selection. */
export class RuntimeDependencies {
  private readonly active = new Map<string, { controller: AbortController, promise: Promise<void> }>()
  private collection: Promise<void> = Promise.resolve()
  private stopped = false
  constructor(private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>, private readonly store: RuntimeDependencyStorePort,
    private readonly preparer: RuntimeDependencyPreparerPort, private readonly clock: Clock, private readonly references: RuntimeDependencyReferencesPort = { list: () => [] },
    private readonly changed: () => Promise<void> = async () => {}) {}
  list(actor: CommunityAccountActor): readonly CommunityRuntimeDependencyView[] { this.assertAdmin(actor); return this.store.list().map(row => this.project(row)) }
  view(actor: CommunityAccountActor, name: string): CommunityRuntimeDependencyView { this.assertAdmin(actor); return this.project(this.require(name)) }
  create(actor: CommunityAccountActor, value: CommunityRuntimeDependencyInput, source: RuntimeDependencySource = 'manual'): CommunityRuntimeDependencyView {
    this.assertAdmin(actor)
    if (this.stopped) throw new BusinessRuleError('conflict', 'Platform is stopping.', 'runtime-dependency-unavailable')
    const input = runtimeDependencyInput(value)
    if (this.store.list().some(row => row.name === input.name)) throw new BusinessRuleError('conflict', 'Runtime dependency name already exists.', 'runtime-dependency-name-conflict')
    const row: RuntimeDependency = { ...input, source, stage: 'preparing', updatedAt: this.clock.now(), log: '', checks: [] }
    this.store.save(row); void this.request(row)
    return this.project(this.require(row.name))
  }
  prepare(actor: CommunityAccountActor, name: string): Promise<void> { this.assertAdmin(actor); return this.request(this.require(name)) }
  async remove(actor: CommunityAccountActor, name: string): Promise<void> {
    this.assertAdmin(actor); this.require(name); this.assertUnreferenced(name)
    const active = this.active.get(name); active?.controller.abort(); await active?.promise
    this.assertAdmin(actor); this.assertUnreferenced(name)
    this.store.remove(name); await this.changed(); await this.collect()
  }
  async recover(): Promise<void> {
    await this.preparer.recover()
    for (const row of this.store.list()) if (row.stage === 'preparing' || row.stage === 'validating') this.store.save({ ...row, stage: 'failed', failureCode: 'interrupted', updatedAt: this.clock.now(), log: row.log + '\nPreparation was interrupted. Prepare again to retry.' })
    await this.collect()
  }
  async stop(): Promise<void> {
    this.stopped = true
    for (const task of this.active.values()) task.controller.abort()
    await Promise.allSettled([...this.active.values()].map(task => task.promise)); await this.collection
  }
  private request(row: RuntimeDependency): Promise<void> {
    if (this.stopped) return Promise.reject(new BusinessRuleError('conflict', 'Platform is stopping.', 'runtime-dependency-unavailable'))
    const existing = this.active.get(row.name)
    if (existing) return existing.promise
    const definition: CommunityRuntimeDependencyInput = { name: row.name, prepareCommand: row.prepareCommand, pathDirectories: row.pathDirectories, ...(row.checkCommand ? { checkCommand: row.checkCommand } : {}) }
    const task = { controller: new AbortController(), promise: Promise.resolve() }
    const retry = { ...row }; delete retry.failureCode
    this.store.save({ ...retry, stage: 'preparing', updatedAt: this.clock.now(), log: '', checks: [] })
    this.active.set(row.name, task)
    task.promise = this.collection.then(() => {
      task.controller.signal.throwIfAborted()
      return this.preparer.prepare(definition, async (log, checks) => {
        task.controller.signal.throwIfAborted()
        const current = this.require(row.name)
        this.store.save({ ...current, stage: checks ? 'validating' : 'preparing', log, checks: checks ?? current.checks, updatedAt: this.clock.now() })
      }, task.controller.signal)
    }).then(async version => {
      task.controller.signal.throwIfAborted()
      const conflict = this.store.list().filter(other => other.name !== row.name).flatMap(other => (other.current?.commands ?? []).filter(command => version.commands.includes(command)).map(command => `${other.name}: ${command}`))
      if (conflict.length) throw new RuntimeDependencyPreparationFailure('command-conflict', `Command names conflict with ${conflict.join(', ')}.`, [...version.checks, { kind: 'commands', passed: false, detail: conflict.join(', ') }])
      const current = { ...this.require(row.name) }; delete current.failureCode
      this.store.save({ ...current, stage: 'ready', current: version, ...(current.current ? { previous: current.current } : {}), checks: version.checks, log: version.log, updatedAt: this.clock.now() })
      await this.changed()
    }).catch(error => {
      const current = this.store.list().find(item => item.name === row.name)
      if (!current) return
      const failure = error instanceof RuntimeDependencyPreparationFailure ? error : new RuntimeDependencyPreparationFailure(task.controller.signal.aborted ? 'interrupted' : 'prepare-failed', task.controller.signal.aborted ? 'Preparation was interrupted. Prepare again to retry.' : 'Preparation could not finish. Check the command and platform storage.')
      this.store.save({ ...current, stage: 'failed', failureCode: failure.code, checks: failure.checks.length ? failure.checks : current.checks, log: current.log + '\n' + failure.log, updatedAt: this.clock.now() })
    }).finally(async () => { this.active.delete(row.name); await this.collect() })
    void task.promise.catch(() => {})
    return task.promise
  }
  private collect(): Promise<void> {
    const next = this.collection.then(async () => {
      if (this.active.size) return
      await this.preparer.collect(this.store.list().flatMap(row => [row.current?.id, row.previous?.id].filter((id): id is string => !!id)))
    })
    this.collection = next.catch(() => {}); return next
  }
  private require(name: string): RuntimeDependency {
    const row = this.store.list().find(item => item.name === name)
    if (!row) throw new BusinessRuleError('missing', 'Runtime dependency is unavailable.', 'runtime-dependency-unavailable')
    return row
  }
  private assertUnreferenced(name: string): void {
    const references = this.references.list(name)
    if (references.length) throw new BusinessRuleError('conflict', 'Runtime dependency is still referenced.', 'runtime-dependency-referenced', { references: references.map(row => `${row.kind}: ${row.name}`).join(', ') })
  }
  private project(row: RuntimeDependency): CommunityRuntimeDependencyView {
    return { name: row.name, prepareCommand: row.prepareCommand, pathDirectories: row.pathDirectories, ...(row.checkCommand ? { checkCommand: row.checkCommand } : {}), source: row.source,
      stage: row.stage, updatedAt: row.updatedAt, isolated: this.preparer.isolated, log: row.log, checks: row.checks, ...(row.failureCode ? { failureCode: row.failureCode } : {}),
      ...(row.current ? { current: { id: row.current.id, bytes: row.current.bytes, commands: row.current.commands, isolated: row.current.isolated } } : {}), references: this.references.list(row.name) }
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required.', 'admin-required')
  }
}
