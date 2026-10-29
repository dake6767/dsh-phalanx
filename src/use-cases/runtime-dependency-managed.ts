import type { CommunityRuntimeDependencyInput } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { pythonPackagePin, pythonPackagePins } from '../domain/python-library.js'
import { replaceRuntimeDefinition, runtimeConflicts } from '../domain/runtime-dependency-record.js'
import {
  runtimeDependencyInput,
  RuntimeDependencyPreparationFailure,
  unownedManualDependency,
  type RuntimeDependency,
  type RuntimeDependencyCheck,
  type RuntimeDependencyDefinition,
  type RuntimeDependencyVersion,
} from '../domain/runtime-dependency.js'
import type { Clock } from '../ports/clock.js'
import type { RuntimeDependencyPreparerPort, RuntimeDependencyReferencesPort, RuntimeDependencyStorePort } from '../ports/runtime-dependencies.js'

export interface ManagedDependencyLifecycle {
  readonly started: boolean
  readonly stopped: boolean
  active(name: string): Promise<void> | undefined
  supersede(name: string): void
  request(row: RuntimeDependency): Promise<void>
  collect(): Promise<void>
  changed(): Promise<void>
}

/** Catalog mutations share the facade's preparation, cancellation and collection owner. */
export class RuntimeDependencyManaged {
  constructor(
    private readonly store: RuntimeDependencyStorePort,
    private readonly preparer: RuntimeDependencyPreparerPort,
    private readonly clock: Clock,
    private readonly references: RuntimeDependencyReferencesPort,
    private readonly lifecycle: ManagedDependencyLifecycle,
  ) {}
  transaction(store: RuntimeDependencyStorePort, references: RuntimeDependencyReferencesPort = this.references) {
    const cancellations = new Set<string>(),
      owner = this.lifecycle
    const scoped = new RuntimeDependencyManaged(store, this.preparer, this.clock, references, {
      started: false,
      get stopped() {
        return owner.stopped
      },
      active: () => undefined,
      supersede: name => {
        cancellations.add(name)
      },
      request: row => owner.request(row),
      collect: async () => {},
      changed: async () => {},
    })
    return {
      mutations: {
        registerManaged: scoped.registerManaged.bind(scoped),
        promoteManaged: scoped.promoteManaged.bind(scoped),
        commitManaged: scoped.commitManaged.bind(scoped),
        updateManaged: scoped.updateManaged.bind(scoped),
        replaceManaged: scoped.replaceManaged.bind(scoped),
        detachManaged: scoped.detachManaged.bind(scoped),
        removeManaged: scoped.removeManaged.bind(scoped),
      },
      committed: () => {
        for (const name of cancellations) owner.supersede(name)
      },
    }
  }
  async resume(): Promise<void> {
    if (!this.lifecycle.started || this.lifecycle.stopped) return
    for (const row of await this.store.list())
      if (row.managedOrigin && row.stage === 'preparing' && !row.preparationIdentity && !this.lifecycle.active(row.name))
        void this.lifecycle.request(row).catch(() => {})
  }
  async registerManaged(
    origin: string,
    value: CommunityRuntimeDependencyInput,
    source: 'manual' | 'mcp-catalog',
    replaces?: string,
    candidate = Boolean(replaces),
  ): Promise<string> {
    const existing = (await this.store.list()).find(row => row.managedOrigin === origin)
    if (existing) return existing.name
    const input = runtimeDependencyInput(value)
    let name = input.name,
      suffix = 0
    while ((await this.store.list()).some(row => row.name === name)) name = `${input.name.slice(0, 90)}-${++suffix}`
    const row: RuntimeDependency = {
      ...input,
      name,
      managedOrigin: origin,
      ...(replaces ? { replaces } : {}),
      ...(candidate ? { candidate: true } : {}),
      source,
      stage: 'preparing',
      updatedAt: this.clock.now(),
      log: '',
      checks: [],
    }
    await this.store.save(row)
    if (this.lifecycle.started) void this.lifecycle.request(row).catch(() => {})
    return name
  }
  async promoteManaged(from: string, to: string): Promise<void> {
    const candidate = await this.require(from),
      current = await this.require(to)
    if (from === to && candidate.source === 'mcp-catalog' && candidate.current && !candidate.replaces) {
      const { candidate: pending, ...published } = candidate
      void pending
      await this.store.save(published)
      return
    }
    if (candidate.replaces !== to || candidate.source !== 'mcp-catalog' || current.source !== 'mcp-catalog' || !candidate.current)
      throw new BusinessRuleError('conflict', 'MCP candidate dependency is unavailable.', 'runtime-dependency-unavailable')
    if (current.current?.id === candidate.current.id) return
    this.lifecycle.supersede(to)
    const { replaces, candidate: pending, ...promoted } = candidate
    void replaces
    void pending
    await this.store.save({
      ...promoted,
      name: to,
      ...(current.rowRevision === undefined ? {} : { rowRevision: current.rowRevision }),
      ...(current.managedOrigin ? { managedOrigin: current.managedOrigin } : {}),
      ...(current.current ? { previous: current.current } : {}),
    })
  }
  async collectManagedCandidates(): Promise<void> {
    for (const row of await this.store.list())
      if (row.candidate && !this.lifecycle.active(row.name) && !(await this.references.list(row.name)).length) await this.store.remove(row.name)
    await this.lifecycle.collect()
  }
  restartManaged(name: string): Promise<void> {
    const request = this.require(name).then(row => this.lifecycle.request(row))
    void request.catch(() => {})
    return request
  }
  /** Suite catalog installs prepare first; library rows appear only after every step succeeded. */
  stageManaged(
    definition: RuntimeDependencyDefinition,
    progress: (log: string, checks?: readonly RuntimeDependencyCheck[]) => Promise<void> = async () => {},
    signal = new AbortController().signal,
  ): Promise<RuntimeDependencyVersion> {
    if (this.lifecycle.stopped) throw new BusinessRuleError('conflict', 'Platform is stopping.', 'runtime-dependency-unavailable')
    return this.preparer.prepare(definition, progress, signal)
  }
  async commitManaged(origin: string, value: CommunityRuntimeDependencyInput, version: RuntimeDependencyVersion): Promise<string> {
    const input = runtimeDependencyInput(value)
    const existing = (await this.store.list()).find(row => row.managedOrigin === origin && (row.managedItem ?? row.name) === input.name)
    if (existing) return existing.name
    const conflict = (await this.store.list()).filter(other => other.name !== input.name).flatMap(other => runtimeConflicts(version, other))
    if (conflict.length)
      throw new RuntimeDependencyPreparationFailure('command-conflict', `Command names conflict with ${conflict.join(', ')}.`, version.checks)
    let name = input.name,
      suffix = 0
    while ((await this.store.list()).some(row => row.name === name)) name = `${input.name.slice(0, 90)}-${++suffix}`
    await this.store.save({
      ...input,
      name,
      managedOrigin: origin,
      managedItem: input.name,
      source: 'suite-catalog',
      stage: 'ready',
      current: version,
      checks: version.checks,
      log: version.log,
      updatedAt: this.clock.now(),
    })
    void this.lifecycle.changed().catch(() => {})
    return name
  }
  /** Switches a suite-owned row to a newly prepared version; the old one stays as previous and references are unchanged. */
  async updateManaged(origin: string, name: string, value: CommunityRuntimeDependencyInput, version: RuntimeDependencyVersion): Promise<void> {
    const row = (await this.store.list()).find(item => item.name === name && item.managedOrigin === origin)
    if (!row) throw new BusinessRuleError('conflict', 'The suite dependency is no longer part of the suite.', 'suite-entry-missing')
    const conflict = (await this.store.list()).filter(other => other.name !== name).flatMap(other => runtimeConflicts(version, other))
    if (conflict.length)
      throw new RuntimeDependencyPreparationFailure('command-conflict', `Command names conflict with ${conflict.join(', ')}.`, version.checks)
    const { failureCode, retryPending, preparationIdentity, ...kept } = row
    void failureCode
    void retryPending
    void preparationIdentity
    await this.store.save({
      ...replaceRuntimeDefinition(kept, runtimeDependencyInput({ ...value, name })),
      stage: 'ready',
      current: version,
      ...(row.current ? { previous: row.current } : {}),
      checks: version.checks,
      log: version.log,
      updatedAt: this.clock.now(),
    })
    void this.lifecycle.changed().catch(() => {})
  }
  /** Rows an origin owns, as an update finds them. */
  async managedRows(origin: string): Promise<readonly RuntimeDependency[]> {
    return structuredClone((await this.store.list()).filter(row => row.managedOrigin === origin))
  }
  /** Puts a suite-owned row back as an update found it, while the suite still owns it. */
  async restoreManaged(origin: string, row: RuntimeDependency): Promise<void> {
    const current = (await this.store.list()).find(item => item.name === row.name)
    if (current && current.managedOrigin !== origin)
      throw new BusinessRuleError('conflict', 'The runtime dependency owner changed during recovery.', 'suite-entry-locked')
    const { rowRevision, ...snapshot } = row
    void rowRevision
    await this.store.save({ ...snapshot, ...(current?.rowRevision === undefined ? {} : { rowRevision: current.rowRevision }) })
    void this.lifecycle.changed().catch(() => {})
  }
  /** Reclaims staged versions that no library row or lease retains. */
  async collectUnretained(): Promise<void> {
    await this.lifecycle.collect()
  }
  /** Manual dependencies that already provide every one of these commands; MCP- or suite-owned rows never qualify. */
  async manualProviders(commands: readonly string[], packages?: readonly string[]): Promise<readonly RuntimeDependency[]> {
    const lock = (values: readonly string[]) =>
      pythonPackagePins(values)
        ?.map(value => {
          const pin = pythonPackagePin(value)!
          return `${pin.name}==${pin.identity}`
        })
        .join('\0')
    return (await this.store.list()).filter(
      row =>
        !row.candidate &&
        unownedManualDependency(row) &&
        row.current &&
        commands.length > 0 &&
        (packages
          ? row.type === 'python-library' && row.stage === 'ready' && row.current.python && lock(row.packages) === lock(packages)
          : !row.current.python) &&
        commands.every(command => row.current!.commands.includes(command)),
    )
  }
  /** Rows of another owner whose commands collide with these. */
  async commandOwners(commands: readonly string[], pythonLibrary = false): Promise<readonly RuntimeDependency[]> {
    return (await this.store.list()).filter(
      row =>
        !row.candidate &&
        (row.current?.commands ?? []).some(command => commands.includes(command) && !(command === 'python3' && pythonLibrary && row.current?.python)),
    )
  }
  /** Takes a manual dependency over in place: the name, and so every reference, stays; the old version is kept as previous.
   * `expected` is the row the install recorded for restore; any change since then refuses the takeover. */
  async replaceManaged(
    origin: string,
    expected: RuntimeDependency,
    value: CommunityRuntimeDependencyInput,
    version: RuntimeDependencyVersion,
  ): Promise<string> {
    const row = (await this.store.list()).find(item => item.name === expected.name)
    if (!row || !unownedManualDependency(row) || JSON.stringify(row) !== JSON.stringify(expected))
      throw new BusinessRuleError('conflict', 'The manual entries changed after the preview. Review the install again.', 'suite-replace-unconfirmed')
    const input = runtimeDependencyInput({ ...value, name: row.name })
    const conflict = (await this.store.list()).filter(other => other.name !== row.name).flatMap(other => runtimeConflicts(version, other))
    if (conflict.length)
      throw new RuntimeDependencyPreparationFailure('command-conflict', `Command names conflict with ${conflict.join(', ')}.`, version.checks)
    // A manual preparation still running must not land on the suite-owned row afterwards.
    this.lifecycle.supersede(row.name)
    // Manual preparation and migration state no longer describe the row; the suite version is its identity now.
    const { failureCode, retryPending, preparationIdentity, ...kept } = row
    void failureCode
    void retryPending
    void preparationIdentity
    await this.store.save({
      ...replaceRuntimeDefinition(kept, input),
      managedOrigin: origin,
      source: 'suite-catalog',
      stage: 'ready',
      current: version,
      ...(row.current ? { previous: row.current } : {}),
      checks: version.checks,
      log: version.log,
      updatedAt: this.clock.now(),
    })
    void this.lifecycle.changed().catch(() => {})
    return row.name
  }
  /** Puts a replaced manual row back exactly as it was, only while the install still owns it. */
  async restoreReplaced(origin: string, row: RuntimeDependency): Promise<void> {
    const current = (await this.store.list()).find(item => item.name === row.name)
    if (current?.managedOrigin !== origin) return
    await this.store.save({ ...row, ...(current.rowRevision === undefined ? {} : { rowRevision: current.rowRevision }) })
    void this.lifecycle.changed().catch(() => {})
    // The takeover stopped a preparation that was running; start it again so the row does not stay preparing.
    if (this.lifecycle.started && (row.stage === 'preparing' || row.stage === 'validating')) void this.lifecycle.request(row).catch(() => {})
  }
  /** Detaching keeps the prepared version, name and references; only ownership changes, so it is edited as a manual dependency. */
  async detachManaged(origin: string, name: string): Promise<void> {
    const row = (await this.store.list()).find(item => item.name === name && item.managedOrigin === origin)
    // Already detached (for example by an interrupted earlier attempt): nothing left to change.
    if (!row) return
    const { managedOrigin, ...detached } = row
    void managedOrigin
    await this.store.save({ ...detached, source: 'manual', updatedAt: this.clock.now() })
  }
  async removeManaged(origin: string, keep: readonly string[] = []): Promise<void> {
    for (const row of (await this.store.list()).filter(item => item.managedOrigin === origin && !keep.includes(item.name))) {
      await this.assertUnreferenced(row.name)
      const active = this.lifecycle.active(row.name)
      this.lifecycle.supersede(row.name)
      await active
      await this.store.remove(row.name)
    }
    await this.lifecycle.changed()
    await this.lifecycle.collect()
  }
  private async assertUnreferenced(name: string): Promise<void> {
    const references = await this.references.list(name)
    if (references.length)
      throw new BusinessRuleError('conflict', 'Runtime dependency is still referenced.', 'runtime-dependency-referenced', {
        references: references.map(row => `${row.kind}: ${row.name}`).join(', '),
      })
  }
  private async require(name: string): Promise<RuntimeDependency> {
    const row = (await this.store.list()).find(item => item.name === name)
    if (!row) throw new BusinessRuleError('missing', 'Runtime dependency is unavailable.', 'runtime-dependency-unavailable')
    return row
  }
}
