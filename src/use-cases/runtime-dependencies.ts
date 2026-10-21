import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityRuntimeDependencyInput, CommunityRuntimeDependencyView } from '../domain/admin-contract.js'
import { runtimeDependencyInput, RuntimeDependencyPreparationFailure, unownedManualDependency, type RuntimeDependencyCheck, type RuntimeDependencyDefinition, type RuntimeDependency, type RuntimeDependencyReference, type RuntimeDependencySource, type RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { RuntimeDependencyStorePort, RuntimeDependencyPreparerPort, RuntimeDependencyReferencesPort } from '../ports/runtime-dependencies.js'
import type { Clock } from '../ports/clock.js'

/** Sole writer of dependency definitions, preparation progress and usable version selection. */
export class RuntimeDependencies {
  private readonly active = new Map<string, { controller: AbortController, promise: Promise<void>, sourceVersion?: string, superseded: boolean }>()
  private readonly retries = new Map<string, Promise<void>>()
  private readonly leases = new Map<string, number>()
  private readonly executions = new Set<Promise<unknown>>()
  private collection: Promise<void> = Promise.resolve()
  private replacedVersions: () => readonly string[] = () => []
  private stopped = false
  private started = false
  constructor(private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>, private readonly store: RuntimeDependencyStorePort,
    private readonly preparer: RuntimeDependencyPreparerPort, private readonly clock: Clock, private readonly references: RuntimeDependencyReferencesPort = { list: () => [] },
    private readonly changed: () => Promise<void> = async () => {}) {}
  version(): string | undefined {
    const store = this.store.version?.()
    return store === undefined ? undefined : `${store}:${Number(this.stopped)}`
  }
  preparing(names: readonly string[]): boolean { return names.some(name => this.active.has(name) || this.retries.has(name)) }
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
  /** Suite catalog installs prepare first; library rows appear only after every step succeeded. */
  stageManaged(definition: RuntimeDependencyDefinition, progress: (log: string, checks?: readonly RuntimeDependencyCheck[]) => Promise<void> = async () => {}, signal = new AbortController().signal): Promise<RuntimeDependencyVersion> {
    if (this.stopped) throw new BusinessRuleError('conflict', 'Platform is stopping.', 'runtime-dependency-unavailable')
    return this.preparer.prepare(definition, progress, signal)
  }
  commitManaged(origin: string, value: CommunityRuntimeDependencyInput, version: RuntimeDependencyVersion): string {
    const existing = this.store.list().find(row => row.managedOrigin === origin)
    if (existing) return existing.name
    const input = runtimeDependencyInput(value)
    const conflict = this.store.list().filter(other => other.name !== input.name)
      .flatMap(other => (other.current?.commands ?? []).filter(command => version.commands.includes(command)).map(command => `${other.name}: ${command}`))
    if (conflict.length) throw new RuntimeDependencyPreparationFailure('command-conflict', `Command names conflict with ${conflict.join(', ')}.`, version.checks)
    let name = input.name, suffix = 0
    while (this.store.list().some(row => row.name === name)) name = `${input.name.slice(0, 90)}-${++suffix}`
    this.store.save({ ...input, name, managedOrigin: origin, source: 'suite-catalog', stage: 'ready', current: version, checks: version.checks, log: version.log, updatedAt: this.clock.now() })
    void this.changed().catch(() => {})
    return name
  }
  /** Switches a suite-owned row to a newly prepared version; the old one stays as previous and references are unchanged. */
  updateManaged(origin: string, name: string, value: CommunityRuntimeDependencyInput, version: RuntimeDependencyVersion): void {
    const row = this.store.list().find(item => item.name === name && item.managedOrigin === origin)
    if (!row) throw new BusinessRuleError('conflict', 'The suite dependency is no longer part of the suite.', 'suite-entry-missing')
    const conflict = this.store.list().filter(other => other.name !== name).flatMap(other => (other.current?.commands ?? []).filter(command => version.commands.includes(command)).map(command => `${other.name}: ${command}`))
    if (conflict.length) throw new RuntimeDependencyPreparationFailure('command-conflict', `Command names conflict with ${conflict.join(', ')}.`, version.checks)
    const { failureCode, retryPending, preparationIdentity, ...kept } = row; void failureCode; void retryPending; void preparationIdentity
    this.store.save({ ...kept, ...runtimeDependencyInput({ ...value, name }), stage: 'ready', current: version, ...(row.current ? { previous: row.current } : {}), checks: version.checks, log: version.log, updatedAt: this.clock.now() })
    void this.changed().catch(() => {})
  }
  /** Rows an origin owns, as an update finds them. */
  managedRows(origin: string): readonly RuntimeDependency[] { return structuredClone(this.store.list().filter(row => row.managedOrigin === origin)) }
  /** Puts a suite-owned row back as an update found it, while the suite still owns it. */
  restoreManaged(origin: string, row: RuntimeDependency): void {
    if (this.store.list().find(item => item.name === row.name)?.managedOrigin !== origin) return
    this.store.save(row); void this.changed().catch(() => {})
  }
  /** Reclaims staged versions that no library row or lease retains. */
  async collectUnretained(): Promise<void> { await this.collect() }
  /** Manual dependencies that already provide every one of these commands; MCP- or suite-owned rows never qualify. */
  manualProviders(commands: readonly string[]): readonly RuntimeDependency[] {
    return this.store.list().filter(row => !row.candidate && unownedManualDependency(row) && row.current && commands.every(command => row.current!.commands.includes(command)))
  }
  /** Rows of another owner whose commands collide with these. */
  commandOwners(commands: readonly string[]): readonly RuntimeDependency[] {
    return this.store.list().filter(row => !row.candidate && (row.current?.commands ?? []).some(command => commands.includes(command)))
  }
  /** Takes a manual dependency over in place: the name, and so every reference, stays; the old version is kept as previous.
   * `expected` is the row the install recorded for restore; any change since then refuses the takeover. */
  replaceManaged(origin: string, expected: RuntimeDependency, value: CommunityRuntimeDependencyInput, version: RuntimeDependencyVersion): string {
    const row = this.store.list().find(item => item.name === expected.name)
    if (!row || !unownedManualDependency(row) || JSON.stringify(row) !== JSON.stringify(expected)) throw new BusinessRuleError('conflict', 'The manual entries changed after the preview. Review the install again.', 'suite-replace-unconfirmed')
    const input = runtimeDependencyInput({ ...value, name: row.name })
    const conflict = this.store.list().filter(other => other.name !== row.name).flatMap(other => (other.current?.commands ?? []).filter(command => version.commands.includes(command)).map(command => `${other.name}: ${command}`))
    if (conflict.length) throw new RuntimeDependencyPreparationFailure('command-conflict', `Command names conflict with ${conflict.join(', ')}.`, version.checks)
    // A manual preparation still running must not land on the suite-owned row afterwards.
    const active = this.active.get(row.name)
    if (active) { active.superseded = true; active.controller.abort() }
    // Manual preparation and migration state no longer describe the row; the suite version is its identity now.
    const { failureCode, retryPending, preparationIdentity, migrationOrigin, sourceVersion, ...kept } = row; void failureCode; void retryPending; void preparationIdentity; void migrationOrigin; void sourceVersion
    this.store.save({ ...kept, ...input, managedOrigin: origin, source: 'suite-catalog', stage: 'ready', current: version, ...(row.current ? { previous: row.current } : {}), checks: version.checks, log: version.log, updatedAt: this.clock.now() })
    void this.changed().catch(() => {})
    return row.name
  }
  /** Puts a replaced manual row back exactly as it was, only while the install still owns it. */
  restoreReplaced(origin: string, row: RuntimeDependency): void {
    if (this.store.list().find(item => item.name === row.name)?.managedOrigin !== origin) return
    this.store.save(row); void this.changed().catch(() => {})
    // The takeover stopped a preparation that was running; start it again so the row does not stay preparing.
    if (this.started && (row.stage === 'preparing' || row.stage === 'validating')) void this.request(row)
  }
  /** Versions of replaced rows that a pending restore may still bring back. */
  retainReplaced(ids: () => readonly string[]): void { this.replacedVersions = ids }
  /** Detaching keeps the prepared version, name and references; only ownership changes, so it is edited as a manual dependency. */
  detachManaged(origin: string, name: string): void {
    const row = this.store.list().find(item => item.name === name && item.managedOrigin === origin)
    // Already detached (for example by an interrupted earlier attempt): nothing left to change.
    if (!row) return
    const { managedOrigin, ...detached } = row; void managedOrigin
    this.store.save({ ...detached, source: 'manual', updatedAt: this.clock.now() })
  }
  async removeManaged(origin: string): Promise<void> {
    for (const row of this.store.list().filter(item => item.managedOrigin === origin)) {
      this.assertUnreferenced(row.name)
      const active = this.active.get(row.name); active?.controller.abort(); await active?.promise
      this.store.remove(row.name)
    }
    await this.changed(); await this.collect()
  }
  dependencyReferences(name: string): readonly RuntimeDependencyReference[] { return this.references.list(name) }
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
    if (row.source === 'suite-catalog') throw new BusinessRuleError('forbidden', 'Suite catalog dependency definitions are read-only. Uninstall the suite or detach the entry first.', 'suite-entry-locked')
    if (this.stopped || this.active.has(name) || this.retries.has(name)) throw new BusinessRuleError('conflict', 'Wait for the current preparation to finish.', 'runtime-dependency-unavailable')
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
    this.assertAdmin(actor); const row = this.require(name); this.assertPublic(row); this.assertUnreferenced(name)
    if (row.source === 'suite-catalog') throw new BusinessRuleError('forbidden', 'Suite catalog dependency definitions are read-only. Uninstall the suite or detach the entry first.', 'suite-entry-locked')
    const active = this.active.get(name); active?.controller.abort(); await active?.promise
    this.assertAdmin(actor); this.assertUnreferenced(name)
    this.store.remove(name); await this.changed(); await this.collect()
  }
  async recover(): Promise<void> {
    await this.preparer.recover()
    for (const row of this.store.list()) if (row.retryPending || row.stage === 'preparing' || row.stage === 'validating') this.store.save({ ...row, retryPending: false, stage: 'failed', failureCode: 'interrupted', updatedAt: this.clock.now(), log: row.log + '\nPreparation was interrupted. Prepare again to retry.' })
    await this.collect()
  }
  async stop(): Promise<void> {
    this.stopped = true
    for (const task of this.active.values()) task.controller.abort()
    await Promise.allSettled([...this.active.values()].map(task => task.promise)); await Promise.allSettled(this.retries.values()); await Promise.allSettled(this.executions); await this.collection
  }
  private request(row: RuntimeDependency): Promise<void> {
    if (this.stopped) return Promise.reject(new BusinessRuleError('conflict', 'Platform is stopping.', 'runtime-dependency-unavailable'))
    const retrying = this.retries.get(row.name)
    if (retrying) return retrying
    const existing = this.active.get(row.name)
    if (existing) {
      if (row.stage !== 'ready' && row.stage !== 'failed') return existing.promise
      this.store.save({ ...row, retryPending: true })
      const queued = existing.promise.then(() => {
        this.retries.delete(row.name)
        existing.controller.signal.throwIfAborted()
        return this.request(this.require(row.name))
      })
      this.retries.set(row.name, queued)
      void queued.finally(() => {
        if (this.retries.has(row.name) && this.retries.get(row.name) !== queued) return
        if (this.retries.get(row.name) === queued) this.retries.delete(row.name)
        const pending = this.store.list().find(item => item.name === row.name)
        if (pending?.retryPending) this.store.save({ ...pending, retryPending: false, stage: 'failed', failureCode: 'interrupted', updatedAt: this.clock.now(), log: pending.log + '\nPreparation was interrupted. Prepare again to retry.' })
      }).catch(() => {})
      return queued
    }
    const definition = this.definition(row)
    const task = { controller: new AbortController(), superseded: false, promise: Promise.resolve(), ...(row.sourceVersion ? { sourceVersion: row.sourceVersion } : {}) }
    const retry = { ...row }; delete retry.failureCode; delete retry.retryPending
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
        this.store.save({ ...current, retryPending: this.require(row.name).retryPending ?? false, stage: 'validating', checks: version.checks, log: version.log, updatedAt: this.clock.now() })
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
      await this.preparer.collect([...this.store.list().flatMap(row => [row.current?.id, row.previous?.id].filter((id): id is string => !!id)), ...this.leases.keys(), ...await this.references.retained?.() ?? [], ...this.replacedVersions()])
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
      stage: row.retryPending ? 'preparing' : row.stage, updatedAt: row.updatedAt, isolated: this.preparer.isolated, log: row.log, checks: row.checks, ...(row.failureCode && !row.retryPending ? { failureCode: row.failureCode } : {}),
      ...(row.current ? { current: { id: row.current.id, bytes: row.current.bytes, commands: row.current.commands, isolated: row.current.isolated } } : {}), references: this.references.list(row.name) }
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required.', 'admin-required')
  }
}
