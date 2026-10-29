import type { CommunityRuntimeDependencyInput, CommunityRuntimeDependencyView } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import { replaceRuntimeDefinition, runtimeDefinition } from '../domain/runtime-dependency-record.js'
import { readyRuntimeDependencies } from '../domain/runtime-dependency-selection.js'
import {
  assertPublicRuntimeDependency,
  runtimeDependencyInput,
  type RuntimeDependency,
  type RuntimeDependencyReference,
  type RuntimeDependencySource,
  type RuntimeDependencyVersion,
} from '../domain/runtime-dependency.js'
import type { Clock } from '../ports/clock.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { RuntimeDependencyPreparerPort, RuntimeDependencyReferencesPort, RuntimeDependencyStoragePort } from '../ports/runtime-dependencies.js'
import { RuntimeDependencyManaged } from './runtime-dependency-managed.js'
import { RuntimeDependencyPreparation } from './runtime-dependency-preparation.js'

/** Sole writer of dependency definitions, preparation progress and usable version selection. */
export class RuntimeDependencies {
  private readonly managed: RuntimeDependencyManaged
  readonly registerManaged: RuntimeDependencyManaged['registerManaged']
  readonly promoteManaged: RuntimeDependencyManaged['promoteManaged']
  readonly restartManaged: RuntimeDependencyManaged['restartManaged']
  readonly commitManaged: RuntimeDependencyManaged['commitManaged']
  readonly updateManaged: RuntimeDependencyManaged['updateManaged']
  readonly managedRows: RuntimeDependencyManaged['managedRows']
  readonly restoreManaged: RuntimeDependencyManaged['restoreManaged']
  readonly manualProviders: RuntimeDependencyManaged['manualProviders']
  readonly commandOwners: RuntimeDependencyManaged['commandOwners']
  readonly replaceManaged: RuntimeDependencyManaged['replaceManaged']
  readonly restoreReplaced: RuntimeDependencyManaged['restoreReplaced']
  readonly detachManaged: RuntimeDependencyManaged['detachManaged']
  readonly stageManaged: RuntimeDependencyManaged['stageManaged']
  readonly collectManagedCandidates: RuntimeDependencyManaged['collectManagedCandidates']
  readonly collectUnretained: RuntimeDependencyManaged['collectUnretained']
  readonly transaction: RuntimeDependencyManaged['transaction']
  readonly resumeManaged: RuntimeDependencyManaged['resume']
  readonly removeManaged: RuntimeDependencyManaged['removeManaged']
  private readonly preparation: RuntimeDependencyPreparation
  constructor(
    private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>,
    private readonly store: RuntimeDependencyStoragePort,
    private readonly preparer: RuntimeDependencyPreparerPort,
    private readonly clock: Clock,
    private readonly references: RuntimeDependencyReferencesPort = { list: async () => [] },
    private readonly changed: () => Promise<void> = async () => {},
  ) {
    this.preparation = new RuntimeDependencyPreparation(store, preparer, clock, references, changed)
    const owner = this.preparation
    this.managed = new RuntimeDependencyManaged(store, preparer, clock, references, {
      get started() {
        return owner.started
      },
      get stopped() {
        return owner.stopped
      },
      active: name => owner.activePromise(name),
      supersede: name => owner.supersede(name),
      request: row => owner.request(row),
      collect: () => owner.collect(),
      changed,
    })
    this.transaction = this.managed.transaction.bind(this.managed)
    this.resumeManaged = this.managed.resume.bind(this.managed)
    this.registerManaged = this.managed.registerManaged.bind(this.managed)
    this.promoteManaged = this.managed.promoteManaged.bind(this.managed)
    this.restartManaged = this.managed.restartManaged.bind(this.managed)
    this.commitManaged = this.managed.commitManaged.bind(this.managed)
    this.updateManaged = this.managed.updateManaged.bind(this.managed)
    this.managedRows = this.managed.managedRows.bind(this.managed)
    this.restoreManaged = this.managed.restoreManaged.bind(this.managed)
    this.manualProviders = this.managed.manualProviders.bind(this.managed)
    this.commandOwners = this.managed.commandOwners.bind(this.managed)
    this.replaceManaged = this.managed.replaceManaged.bind(this.managed)
    this.restoreReplaced = this.managed.restoreReplaced.bind(this.managed)
    this.detachManaged = this.managed.detachManaged.bind(this.managed)
    this.stageManaged = this.managed.stageManaged.bind(this.managed)
    this.collectManagedCandidates = this.managed.collectManagedCandidates.bind(this.managed)
    this.collectUnretained = this.managed.collectUnretained.bind(this.managed)
    this.removeManaged = this.managed.removeManaged.bind(this.managed)
  }
  version(): string | undefined {
    const store = this.store.view.version()
    return store === undefined ? undefined : `${store}:${Number(this.preparation.stopped)}`
  }
  preparing(names: readonly string[]): boolean {
    return this.preparation.preparing(names)
  }
  async inspect(names: readonly string[]) {
    const rows = await this.store.list()
    return [...new Set(names)].map(name => {
      const row = rows.find(item => item.name === name)
      if (!row) throw new BusinessRuleError('missing', 'Runtime dependency is unavailable.', 'runtime-dependency-unavailable')
      return { stage: row.stage, updatedAt: row.updatedAt, log: row.log, current: row.current }
    })
  }
  state(name: string) {
    const row = this.requireView(name)
    return { stage: row.stage, updatedAt: row.updatedAt, log: row.log }
  }
  /** Versions of replaced rows that a pending restore may still bring back. */

  async dependencyReferences(name: string): Promise<readonly RuntimeDependencyReference[]> {
    return await this.references.list(name)
  }
  async list(actor: CommunityAccountActor): Promise<readonly CommunityRuntimeDependencyView[]> {
    await this.assertAdmin(actor)
    const rows = (await this.store.list()).filter(row => !row.candidate)
    return await Promise.all(rows.map(row => this.project(row)))
  }
  async view(actor: CommunityAccountActor, name: string): Promise<CommunityRuntimeDependencyView> {
    await this.assertAdmin(actor)
    const row = await this.require(name)
    assertPublicRuntimeDependency(row)
    return await this.project(row)
  }
  async create(
    actor: CommunityAccountActor,
    value: CommunityRuntimeDependencyInput,
    source: RuntimeDependencySource = 'manual',
  ): Promise<CommunityRuntimeDependencyView> {
    await this.assertAdmin(actor)
    if (this.preparation.stopped) throw new BusinessRuleError('conflict', 'Platform is stopping.', 'runtime-dependency-unavailable')
    const input = runtimeDependencyInput(value)
    if ((await this.store.list()).some(row => row.name === input.name))
      throw new BusinessRuleError('conflict', 'Runtime dependency name already exists.', 'runtime-dependency-name-conflict')
    const row: RuntimeDependency = { ...input, source, stage: 'preparing', updatedAt: this.clock.now(), log: '', checks: [] }
    await this.store.save(row)
    void this.preparation.request(row).catch(() => {})
    await this.preparation.starting(row.name)
    return this.project(await this.require(row.name))
  }
  async prepare(actor: CommunityAccountActor, name: string): Promise<void> {
    await this.assertAdmin(actor)
    const row = await this.require(name)
    assertPublicRuntimeDependency(row)
    return this.preparation.request(row)
  }
  async update(actor: CommunityAccountActor, name: string, value: CommunityRuntimeDependencyInput): Promise<CommunityRuntimeDependencyView> {
    await this.assertAdmin(actor)
    const row = await this.require(name),
      input = runtimeDependencyInput(value)
    assertPublicRuntimeDependency(row)
    if (row.source === 'mcp-catalog') throw new BusinessRuleError('forbidden', 'MCP catalog dependency definitions are read-only.', 'runtime-dependency-locked')
    if (row.source === 'suite-catalog')
      throw new BusinessRuleError(
        'forbidden',
        'Suite catalog dependency definitions are read-only. Uninstall the suite or detach the entry first.',
        'suite-entry-locked',
      )
    if (this.preparation.stopped || this.preparation.preparing([name]))
      throw new BusinessRuleError('conflict', 'Wait for the current preparation to finish.', 'runtime-dependency-unavailable')
    if (input.name !== name) throw new BusinessRuleError('invalid', 'Dependency names cannot be changed.', 'runtime-dependency-invalid')
    const next = replaceRuntimeDefinition(row, input)
    const identity = this.preparer.identity(runtimeDefinition(next))
    await this.store.save(next)
    if (identity !== (row.preparationIdentity ?? row.current?.identity)) {
      void this.preparation.request(next).catch(() => {})
      await this.preparation.starting(name)
    }
    return this.project(await this.require(name))
  }
  start(): Promise<void> {
    return this.preparation.start()
  }
  ready(names: readonly string[], includeCandidates = false): readonly RuntimeDependencyVersion[] {
    if (this.preparation.stopped) throw new BusinessRuleError('conflict', 'Platform is stopping.', 'runtime-dependency-unavailable')
    return this.selectReady(names.length ? this.store.view.list() : [], names, includeCandidates)
  }
  async readReady(names: readonly string[], includeCandidates = false): Promise<readonly RuntimeDependencyVersion[]> {
    if (this.preparation.stopped) throw new BusinessRuleError('conflict', 'Platform is stopping.', 'runtime-dependency-unavailable')
    const rows = names.length ? await this.store.list() : []
    if (this.preparation.stopped) throw new BusinessRuleError('conflict', 'Platform is stopping.', 'runtime-dependency-unavailable')
    return this.selectReady(rows, names, includeCandidates)
  }
  private selectReady(rows: readonly RuntimeDependency[], names: readonly string[], includeCandidates: boolean): readonly RuntimeDependencyVersion[] {
    return readyRuntimeDependencies(rows, names, includeCandidates)
  }

  async withPrepared<T>(names: readonly string[], run: (versions: readonly RuntimeDependencyVersion[]) => Promise<T>): Promise<T> {
    return this.withVersions(this.ready(names), run)
  }
  /** A catalog candidate remains owned through later preparation and its final commit or discard. */
  withPreparedVersion<T>(prepare: () => Promise<RuntimeDependencyVersion>, run: (version: RuntimeDependencyVersion) => Promise<T>): Promise<T> {
    return this.preparation.withPreparedVersion(prepare, run)
  }
  /** Retain an already frozen startup plan without resolving newer versions by name. */
  withVersions<T>(versions: readonly RuntimeDependencyVersion[], run: (versions: readonly RuntimeDependencyVersion[]) => Promise<T>): Promise<T> {
    return this.preparation.withVersions(versions, run)
  }
  async remove(actor: CommunityAccountActor, name: string): Promise<void> {
    await this.assertAdmin(actor)
    return this.preparation.withRemoval(name, async () => {
      const row = await this.require(name)
      assertPublicRuntimeDependency(row)
      await this.assertUnreferenced(name)
      if (row.source === 'suite-catalog')
        throw new BusinessRuleError(
          'forbidden',
          'Suite catalog dependency definitions are read-only. Uninstall the suite or detach the entry first.',
          'suite-entry-locked',
        )
      await this.preparation.cancel(name)
      await this.assertAdmin(actor)
      await this.assertUnreferenced(name)
      await this.store.remove(name)
      await this.changed()
      await this.preparation.collect()
    })
  }
  recover(): Promise<void> {
    return this.preparation.recover()
  }
  stop(): Promise<void> {
    return this.preparation.stop()
  }
  private async require(name: string): Promise<RuntimeDependency> {
    const row = (await this.store.list()).find(item => item.name === name)
    if (!row) throw new BusinessRuleError('missing', 'Runtime dependency is unavailable.', 'runtime-dependency-unavailable')
    return row
  }
  private requireView(name: string): RuntimeDependency {
    const row = this.store.view.list().find(item => item.name === name)
    if (!row) throw new BusinessRuleError('missing', 'Runtime dependency is unavailable.', 'runtime-dependency-unavailable')
    return row
  }
  private async assertUnreferenced(name: string): Promise<void> {
    const references = await this.references.list(name)
    if (references.length)
      throw new BusinessRuleError('conflict', 'Runtime dependency is still referenced.', 'runtime-dependency-referenced', {
        references: references.map(row => `${row.kind}: ${row.name}`).join(', '),
      })
  }
  private async project(row: RuntimeDependency): Promise<CommunityRuntimeDependencyView> {
    const definition = runtimeDefinition(row)
    return {
      ...definition,
      source: row.source,
      stage: row.retryPending ? 'preparing' : row.stage,
      updatedAt: row.updatedAt,
      isolated: this.preparer.isolated,
      log: row.log,
      checks: row.checks,
      ...(row.failureCode && !row.retryPending ? { failureCode: row.failureCode } : {}),
      ...(row.current ? { current: { id: row.current.id, bytes: row.current.bytes, commands: row.current.commands, isolated: row.current.isolated } } : {}),
      references: await this.references.list(row.name),
    }
  }
  private async assertAdmin(actor: CommunityAccountActor): Promise<void> {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required.', 'admin-required')
  }
}
