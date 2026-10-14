import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityRuntimeDependencyInput, CommunityRuntimeDependencyView } from '../domain/admin-contract.js'
import { runtimeDependencyInput, RuntimeDependencyPreparationFailure, type RuntimeDependencyDefinition, type RuntimeDependency, type RuntimeDependencySource, type RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { RuntimeDependencyStorePort, RuntimeDependencyPreparerPort, RuntimeDependencyReferencesPort } from '../ports/runtime-dependencies.js'
import type { Clock } from '../ports/clock.js'

/** Sole writer of dependency definitions, preparation progress and usable version selection. */
export class RuntimeDependencies {
  private readonly active = new Map<string, { controller: AbortController, promise: Promise<void>, sourceVersion?: string, superseded: boolean }>()
  private readonly leases = new Map<string, number>()
  private readonly executions = new Set<Promise<unknown>>()
  private collection: Promise<void> = Promise.resolve()
  private stopped = false
  private started = false
  constructor(private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>, private readonly store: RuntimeDependencyStorePort,
    private readonly preparer: RuntimeDependencyPreparerPort, private readonly clock: Clock, private readonly references: RuntimeDependencyReferencesPort = { list: () => [] },
    private readonly changed: () => Promise<void> = async () => {}) {}
  preparing(names: readonly string[]): boolean { return names.some(name => this.active.has(name)) }
  sourceVersions(): readonly string[] { return [...this.store.list(), ...this.active.values()].flatMap(row => row.sourceVersion ? [row.sourceVersion] : []) }
  state(name: string) { const row = this.require(name); return { ...(row.migrationOrigin ? { migrationOrigin: row.migrationOrigin } : {}), stage: row.stage, updatedAt: row.updatedAt, log: row.log } }
  updateSource(origin: string, sourceVersion: string): void {
    const row = this.store.list().find(item => item.migrationOrigin === origin)
    if (!row || row.sourceVersion === sourceVersion) return
    this.store.save({ ...row, sourceVersion })
    if (this.started) void (this.active.get(row.name)?.promise ?? Promise.resolve()).then(() => {
      const current = this.store.list().find(item => item.name === row.name)
      if (current && !this.stopped && current.preparationIdentity !== this.preparer.identity(this.definition(current))) return this.request(current)
    }).catch(() => {})
  }
  migrate(origin: string, value: CommunityRuntimeDependencyInput, sourceVersion: string): string {
    const existing = this.store.list().find(row => row.migrationOrigin === origin)
    if (existing) return existing.name
    const input = runtimeDependencyInput(value)
    let name = input.name, suffix = 0
    while (this.store.list().some(row => row.name === name)) name = `${input.name.slice(0, 90)}-${++suffix}`
    this.store.save({ ...input, name, sourceVersion, migrationOrigin: origin, source: 'migration-0.1.10', stage: 'preparing', updatedAt: this.clock.now(), log: '', checks: [] })
    if (this.started) void this.request(this.require(name))
    return name
  }
  registerManaged(origin: string, value: CommunityRuntimeDependencyInput, source: 'manual' | 'mcp-catalog', replaces?: string, candidate = Boolean(replaces)): string {
    const existing = this.store.list().find(row => row.managedOrigin === origin)
    if (existing) return existing.name
    const input = runtimeDependencyInput(value)
    let name = input.name, suffix = 0
    while (this.store.list().some(row => row.name === name)) name = `${input.name.slice(0, 90)}-${++suffix}`
    const row: RuntimeDependency = { ...input, name, managedOrigin: origin, ...(replaces ? { replaces } : {}), ...(candidate ? { candidate: true } : {}), source, stage: 'preparing', updatedAt: this.clock.now(), log: '', checks: [] }
    this.store.save(row)
    if (this.started) void this.request(row)
    return name
  }
  promoteManaged(from: string, to: string): void {
    const candidate = this.require(from), current = this.require(to)
    if (from === to && candidate.source === 'mcp-catalog' && candidate.current && !candidate.replaces) {
      const { candidate: pending, ...published } = candidate; void pending
      this.store.save(published); return
    }
    if (candidate.replaces !== to || candidate.source !== 'mcp-catalog' || current.source !== 'mcp-catalog' || !candidate.current) throw new BusinessRuleError('conflict', 'MCP candidate dependency is unavailable.', 'runtime-dependency-unavailable')
    if (current.current?.id === candidate.current.id) return
    const active = this.active.get(to)
    if (active) { active.superseded = true; active.controller.abort() }
    const { replaces, candidate: pending, ...promoted } = candidate; void replaces; void pending
    this.store.save({ ...promoted, name: to, ...(current.managedOrigin ? { managedOrigin: current.managedOrigin } : {}), ...(current.current ? { previous: current.current } : {}) })
  }
  async collectManagedCandidates(): Promise<void> {
    for (const row of this.store.list()) if (row.candidate && !this.active.has(row.name) && !this.references.list(row.name).length) this.store.remove(row.name)
    await this.collect()
  }
  restartManaged(name: string): Promise<void> { return this.request(this.require(name)) }
  list(actor: CommunityAccountActor): readonly CommunityRuntimeDependencyView[] { this.assertAdmin(actor); return this.store.list().filter(row => !row.candidate).map(row => this.project(row)) }
  view(actor: CommunityAccountActor, name: string): CommunityRuntimeDependencyView { this.assertAdmin(actor); const row = this.require(name); this.assertPublic(row); return this.project(row) }
  create(actor: CommunityAccountActor, value: CommunityRuntimeDependencyInput, source: RuntimeDependencySource = 'manual'): CommunityRuntimeDependencyView {
    this.assertAdmin(actor)
    if (this.stopped) throw new BusinessRuleError('conflict', 'Platform is stopping.', 'runtime-dependency-unavailable')
    const input = runtimeDependencyInput(value)
    if (this.store.list().some(row => row.name === input.name)) throw new BusinessRuleError('conflict', 'Runtime dependency name already exists.', 'runtime-dependency-name-conflict')
    const row: RuntimeDependency = { ...input, source, stage: 'preparing', updatedAt: this.clock.now(), log: '', checks: [] }
    this.store.save(row); void this.request(row)
    return this.project(this.require(row.name))
  }
  prepare(actor: CommunityAccountActor, name: string): Promise<void> { this.assertAdmin(actor); const row = this.require(name); this.assertPublic(row); return this.request(row) }
  update(actor: CommunityAccountActor, name: string, value: CommunityRuntimeDependencyInput): CommunityRuntimeDependencyView {
    this.assertAdmin(actor)
    const row = this.require(name), input = runtimeDependencyInput(value)
    this.assertPublic(row)
    if (row.source === 'mcp-catalog') throw new BusinessRuleError('forbidden', 'MCP catalog dependency definitions are read-only.', 'runtime-dependency-locked')
    if (this.stopped || this.active.has(name)) throw new BusinessRuleError('conflict', 'Wait for the current preparation to finish.', 'runtime-dependency-unavailable')
    if (input.name !== name) throw new BusinessRuleError('invalid', 'Dependency names cannot be changed.', 'runtime-dependency-invalid')
    const next = { ...row, ...input }
    if (input.checkCommand === undefined) delete next.checkCommand
    const identity = this.preparer.identity(this.definition(next))
    this.store.save(next)
    if (identity !== (row.preparationIdentity ?? row.current?.identity)) void this.request(next)
    return this.project(this.require(name))
  }
  start(): void {
    if (this.stopped) return
    this.started = true
    for (const row of this.store.list()) {
      const previous = row.preparationIdentity ?? row.current?.identity
      if (!previous || previous !== this.preparer.identity(this.definition(row))) void this.request(row)
    }
  }
  ready(names: readonly string[], includeCandidates = false): readonly RuntimeDependencyVersion[] {
    if (this.stopped) throw new BusinessRuleError('conflict', 'Platform is stopping.', 'runtime-dependency-unavailable')
    return [...new Set(names)].map(name => {
      const row = this.require(name)
      if (!includeCandidates) this.assertPublic(row)
      if (!row.current) throw new BusinessRuleError('conflict', 'Runtime dependency has no usable version.', 'runtime-dependency-unavailable', { name })
      return row.current
    })
  }
  async withPrepared<T>(names: readonly string[], run: (versions: readonly RuntimeDependencyVersion[]) => Promise<T>): Promise<T> {
    const versions = this.ready(names)
    for (const version of versions) this.leases.set(version.id, (this.leases.get(version.id) ?? 0) + 1)
    const task = (async () => {
      try { return await run(versions) }
      finally {
        for (const version of versions) {
          const remaining = this.leases.get(version.id)! - 1
          if (remaining) this.leases.set(version.id, remaining); else this.leases.delete(version.id)
        }
        await this.collect()
      }
    })()
    this.executions.add(task)
    try { return await task } finally { this.executions.delete(task) }
  }
  async remove(actor: CommunityAccountActor, name: string): Promise<void> {
    this.assertAdmin(actor); this.assertPublic(this.require(name)); this.assertUnreferenced(name)
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
    await Promise.allSettled([...this.active.values()].map(task => task.promise)); await Promise.allSettled(this.executions); await this.collection
  }
  private request(row: RuntimeDependency): Promise<void> {
    if (this.stopped) return Promise.reject(new BusinessRuleError('conflict', 'Platform is stopping.', 'runtime-dependency-unavailable'))
    const existing = this.active.get(row.name)
    if (existing) {
      if (row.stage !== 'ready' && row.stage !== 'failed') return existing.promise
      const queued = existing.promise.then(() => {
        existing.controller.signal.throwIfAborted()
        return this.request(this.require(row.name))
      })
      void queued.catch(() => {})
      return queued
    }
    const definition = this.definition(row)
    const task = { controller: new AbortController(), superseded: false, promise: Promise.resolve(), ...(row.sourceVersion ? { sourceVersion: row.sourceVersion } : {}) }
    const retry = { ...row }; delete retry.failureCode
    this.store.save({ ...retry, preparationIdentity: this.preparer.identity(definition), stage: 'preparing', updatedAt: this.clock.now(), log: '', checks: [] })
    this.active.set(row.name, task)
    task.promise = this.collection.then(() => {
      task.controller.signal.throwIfAborted()
      return this.preparer.prepare(definition, async (log, checks) => {
        task.controller.signal.throwIfAborted()
        const current = this.require(row.name)
        this.store.save({ ...current, stage: checks ? 'validating' : 'preparing', log, checks: checks ?? current.checks, updatedAt: this.clock.now() })
      }, task.controller.signal)
    }).then(async version => {
      if (task.superseded) return
      task.controller.signal.throwIfAborted()
      const conflict = this.store.list().filter(other => other.name !== row.name && other.name !== row.replaces && other.replaces !== row.name && !(row.replaces && other.replaces === row.replaces)).flatMap(other => (other.current?.commands ?? []).filter(command => version.commands.includes(command)).map(command => `${other.name}: ${command}`))
      if (conflict.length) throw new RuntimeDependencyPreparationFailure('command-conflict', `Command names conflict with ${conflict.join(', ')}.`, [...version.checks, { kind: 'commands', passed: false, detail: conflict.join(', ') }])
      const current = { ...this.require(row.name) }; delete current.failureCode
      this.store.save({ ...current, stage: 'ready', current: version, ...(current.current ? { previous: current.current } : {}), checks: version.checks, log: version.log, updatedAt: this.clock.now() })
      try { await this.changed() }
      catch (error) {
        if (task.superseded) return
        this.store.save({ ...current, stage: 'validating', checks: version.checks, log: version.log, updatedAt: this.clock.now() })
        await this.changed(); throw error
      }
    }).catch(async error => {
      if (task.superseded) return
      const current = this.store.list().find(item => item.name === row.name)
      if (!current) return
      const failure = error instanceof RuntimeDependencyPreparationFailure ? error : new RuntimeDependencyPreparationFailure(task.controller.signal.aborted ? 'interrupted' : 'prepare-failed', task.controller.signal.aborted ? 'Preparation was interrupted. Prepare again to retry.' : 'Preparation could not finish. Check the command and platform storage.')
      this.store.save({ ...current, stage: 'failed', failureCode: failure.code, checks: failure.checks.length ? failure.checks : current.checks, log: current.log + '\n' + failure.log, updatedAt: this.clock.now() })
      await this.changed()
    }).finally(async () => { this.active.delete(row.name); await this.collect() })
    void task.promise.catch(() => {})
    return task.promise
  }
  private collect(): Promise<void> {
    const next = this.collection.then(async () => {
      if (this.active.size) return
      await this.preparer.collect([...this.store.list().flatMap(row => [row.current?.id, row.previous?.id].filter((id): id is string => !!id)), ...this.leases.keys(), ...await this.references.retained?.() ?? []])
    })
    this.collection = next.catch(() => {}); return next
  }
  private definition(row: RuntimeDependency): RuntimeDependencyDefinition {
    return { ...(row.sourceVersion ? { sourceVersion: row.sourceVersion } : {}), name: row.name, prepareCommand: row.prepareCommand, pathDirectories: row.pathDirectories, ...(row.checkCommand ? { checkCommand: row.checkCommand } : {}) }
  }
  private require(name: string): RuntimeDependency {
    const row = this.store.list().find(item => item.name === name)
    if (!row) throw new BusinessRuleError('missing', 'Runtime dependency is unavailable.', 'runtime-dependency-unavailable')
    return row
  }
  private assertPublic(row: RuntimeDependency): void {
    if (row.candidate) throw new BusinessRuleError('conflict', 'MCP update candidates are internal.', 'runtime-dependency-unavailable')
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
