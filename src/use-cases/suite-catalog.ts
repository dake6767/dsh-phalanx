import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityRuntimeDependencyInput, CommunitySuiteCatalogView, CommunitySuiteInstallPreview, CommunitySuiteInstallView, CommunitySuiteUninstallPreview } from '../domain/admin-contract.js'
import { suiteInstallInput, suiteRuntimeDependencyDefinition, type SuiteCatalogArchitecture, type SuiteCatalogItem, type SuiteCatalogRuntimeDependencyItem, type SuiteCatalogEntry } from '../domain/suite-catalog.js'
import { suiteInstallOrigin, type SuiteInstalledEntry, type SuiteInstallRecord, type SuiteInstallState } from '../domain/suite-install.js'
import { RuntimeDependencyPreparationFailure, type RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { Clock } from '../ports/clock.js'
import type { SuiteInstallStorePort } from '../ports/suite-catalog.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'

interface SuiteItemPlan { name: string, definition: CommunityRuntimeDependencyInput, commands: readonly string[] }

/** Each entry kind implements plan, prepare, commit, rollback and uninstall with the same shape. */
interface SuiteItemOperations<Item extends SuiteCatalogItem, Prepared> {
  available(item: Item): boolean
  plan(item: Item): SuiteItemPlan
  prepare(item: Item, plan: SuiteItemPlan, log: (line: string) => Promise<void>): Promise<Prepared>
  commit(item: Item, plan: SuiteItemPlan, prepared: Prepared, origin: string): Promise<SuiteInstalledEntry>
  rollback(prepared: Prepared): Promise<void>
  uninstall(entry: SuiteInstalledEntry, origin: string): Promise<void>
  references(entry: SuiteInstalledEntry): readonly { kind: string, name: string }[]
}

class RuntimeDependencySuiteKind implements SuiteItemOperations<SuiteCatalogRuntimeDependencyItem, RuntimeDependencyVersion> {
  constructor(private readonly dependencies: RuntimeDependencies, private readonly architecture: () => SuiteCatalogArchitecture, private readonly signal: () => AbortSignal) {}
  available(item: SuiteCatalogRuntimeDependencyItem): boolean { return Boolean(suiteRuntimeDependencyDefinition(item, this.architecture())) }
  plan(item: SuiteCatalogRuntimeDependencyItem): SuiteItemPlan {
    const definition = suiteRuntimeDependencyDefinition(item, this.architecture())
    if (!definition) throw new BusinessRuleError('invalid', 'This suite entry has no preparation for the current architecture.', 'suite-arch-unavailable')
    return { name: definition.name, definition, commands: item.commands }
  }
  async prepare(_item: SuiteCatalogRuntimeDependencyItem, plan: SuiteItemPlan, log: (line: string) => Promise<void>): Promise<RuntimeDependencyVersion> {
    await log(`Preparing runtime dependency ${plan.name}…`)
    try { return await this.dependencies.stageManaged(plan.definition, async () => {}, this.signal()) }
    catch (error) {
      if (error instanceof RuntimeDependencyPreparationFailure) await log(error.log.trimEnd())
      throw error
    }
  }
  async commit(_item: SuiteCatalogRuntimeDependencyItem, plan: SuiteItemPlan, version: RuntimeDependencyVersion, origin: string): Promise<SuiteInstalledEntry> {
    return { kind: 'runtime-dependency', name: this.dependencies.commitManaged(origin, plan.definition, version) }
  }
  rollback(): Promise<void> { return this.dependencies.collectUnretained() }
  uninstall(entry: SuiteInstalledEntry, origin: string): Promise<void> { void entry; return this.dependencies.removeManaged(origin) }
  references(entry: SuiteInstalledEntry) { return this.dependencies.dependencyReferences(entry.name).map(reference => ({ kind: reference.kind, name: reference.name })) }
}

interface PreparedJob { readonly operations: SuiteItemOperations<SuiteCatalogItem, unknown>, readonly item: SuiteCatalogItem, readonly plan: SuiteItemPlan, readonly value: unknown }

/** Plans and runs suite catalog installs; library rows appear only after every step succeeded. */
export class SuiteCatalog {
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly shutdown = new AbortController()
  private readonly runtimeDependencyKind: RuntimeDependencySuiteKind
  constructor(private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>, private readonly presets: readonly SuiteCatalogEntry[], private readonly store: SuiteInstallStorePort,
    private readonly dependencies: RuntimeDependencies, private readonly clock: Clock, private readonly architecture: SuiteCatalogArchitecture) {
    this.runtimeDependencyKind = new RuntimeDependencySuiteKind(dependencies, () => architecture, () => this.shutdown.signal)
  }
  catalog(actor: CommunityAccountActor): CommunitySuiteCatalogView {
    this.assertAdmin(actor)
    const state = this.store.read()
    return {
      entries: this.presets.map(entry => {
        const record = state.installs.find(row => row.id === entry.id)
        return { id: entry.id, category: entry.category, title: entry.title, description: entry.description, source: entry.source, version: entry.version,
          commands: [...new Set(entry.items.flatMap(item => item.commands))], available: this.available(entry),
          ...(record ? { installedVersion: record.version, ...(record.status === 'installed' && record.version !== entry.version ? { updateAvailable: true } : {}) } : {}) }
      }),
      installations: state.installs.map(row => this.view(row)),
    }
  }
  installPreview(actor: CommunityAccountActor, id: string): CommunitySuiteInstallPreview {
    this.assertAdmin(actor)
    const entry = this.require(id), record = this.store.read().installs.find(row => row.id === id)
    const available = this.available(entry)
    const reason = record?.status === 'installed' ? 'already-installed' : record && record.status !== 'failed' ? 'task-running' : !available ? 'unavailable-architecture' : undefined
    const creates = reason === undefined ? entry.items.map(item => this.operationsFor(item.kind).plan(item)).map(plan => ({ kind: 'runtime-dependency' as const, name: plan.name, commands: plan.commands })) : []
    return { id, version: entry.version, available, ...(reason ? { reason } : {}), creates }
  }
  uninstallPreview(actor: CommunityAccountActor, id: string): CommunitySuiteUninstallPreview {
    this.assertAdmin(actor)
    const record = this.requireInstalled(id)
    const blocked = record.entries.flatMap(entry => { const references = this.operationsFor(entry.kind).references(entry); return references.length ? [{ name: entry.name, references }] : [] })
    return { id, removes: record.entries, blocked }
  }
  install(actor: CommunityAccountActor, input: unknown): CommunitySuiteInstallView {
    this.assertAdmin(actor)
    const value = suiteInstallInput(input)
    const entry = this.require(value.id)
    const state = this.store.read()
    if (state.requests?.includes(value.requestId)) {
      const existing = state.installs.find(row => row.requestId === value.requestId)
      if (existing) return this.view(existing)
      throw new BusinessRuleError('conflict', 'This install request was already retired. Start a new install.', 'suite-request-retired')
    }
    const previous = state.installs.find(row => row.id === value.id)
    if (previous && previous.status !== 'failed') throw new BusinessRuleError('conflict',
      previous.status === 'installed' ? 'This catalog entry is already installed.' : 'A task is already running for this entry.',
      previous.status === 'installed' ? 'suite-already-installed' : 'suite-task-running')
    if (!this.available(entry)) throw new BusinessRuleError('invalid', 'This suite entry has no preparation for the current architecture.', 'suite-arch-unavailable')
    const record: SuiteInstallRecord = { id: entry.id, version: entry.version, status: 'installing', entries: [], requestId: value.requestId, updatedAt: this.clock.now(),
      log: `${previous?.log ? previous.log + '\n---\n' : ''}Installing ${entry.id} ${entry.version}…` }
    this.write(next => ({ ...next, requests: [...next.requests ?? [], value.requestId].slice(-200), installs: [...next.installs.filter(item => item.id !== entry.id), record] }))
    this.startInstall(entry)
    return this.view(record)
  }
  uninstall(actor: CommunityAccountActor, id: string): void {
    this.assertAdmin(actor)
    const record = this.requireInstalled(id)
    const blocked = record.entries.flatMap(entry => this.operationsFor(entry.kind).references(entry))
    if (blocked.length) throw new BusinessRuleError('conflict', 'Runtime dependency is still referenced.', 'runtime-dependency-referenced', { references: blocked.map(reference => `${reference.kind}: ${reference.name}`).join(', ') })
    this.saveRecord(id, row => ({ ...row, status: 'uninstalling', updatedAt: this.clock.now(), log: row.log + '\nUninstalling…' }))
    this.startUninstall(id, record.status)
  }
  /** Interrupted tasks carry no in-memory job after a restart; committed rows are rolled back here. */
  async recover(): Promise<void> {
    for (const row of this.store.read().installs) {
      if (this.jobs.has(row.id)) continue
      if (row.status === 'installing') {
        await this.dependencies.removeManaged(suiteInstallOrigin(row.id)).catch(() => {})
        this.saveRecord(row.id, record => ({ ...record, status: 'failed', failureCode: 'interrupted', updatedAt: this.clock.now(), log: record.log + '\nInstallation was interrupted. Retry to install again.' }))
      } else if (row.status === 'uninstalling') {
        // Keep the record when removal is blocked so the administrator can still uninstall later.
        const removed = await this.dependencies.removeManaged(suiteInstallOrigin(row.id)).then(() => true, () => false)
        if (removed) this.write(state => ({ ...state, installs: state.installs.filter(item => item.id !== row.id) }))
        else this.saveRecord(row.id, record => ({ ...record, status: 'installed', updatedAt: this.clock.now(), log: record.log + '\nUninstall was interrupted and is still referenced. Remove the references and uninstall again.' }))
      }
    }
  }
  async stop(): Promise<void> {
    this.shutdown.abort()
    await Promise.allSettled([...this.jobs.values()])
  }
  private startInstall(entry: SuiteCatalogEntry): void {
    if (this.jobs.has(entry.id)) return
    const job = this.runInstall(entry).finally(() => this.jobs.delete(entry.id))
    this.jobs.set(entry.id, job); void job.catch(() => {})
  }
  private async runInstall(entry: SuiteCatalogEntry): Promise<void> {
    const prepared: PreparedJob[] = []
    let committed = 0
    const log = (line: string) => this.appendLog(entry.id, line)
    try {
      for (const item of entry.items) {
        const operations = this.operationsFor(item.kind)
        const plan = operations.plan(item)
        prepared.push({ operations, item, plan, value: await operations.prepare(item, plan, log) })
        await log(`Runtime dependency ${plan.name} prepared.`)
      }
      const installed: SuiteInstalledEntry[] = []
      await log('Writing library entries…')
      for (const job of prepared) { installed.push(await job.operations.commit(job.item, job.plan, job.value, suiteInstallOrigin(entry.id))); committed++ }
      this.saveRecord(entry.id, row => {
        const { failureCode, ...record } = row; void failureCode
        return { ...record, status: 'installed', version: entry.version, entries: installed, updatedAt: this.clock.now() }
      })
      await log('Installed.')
    } catch (error) {
      for (const job of [...prepared].reverse()) await job.operations.rollback(job.value).catch(() => {})
      // A failure after the first commit leaves owned rows behind; remove the whole origin again.
      if (committed > 0) await this.dependencies.removeManaged(suiteInstallOrigin(entry.id)).catch(() => {})
      const failure = error instanceof RuntimeDependencyPreparationFailure || error instanceof BusinessRuleError ? error.code : 'prepare-failed'
      this.saveRecord(entry.id, row => ({ ...row, status: 'failed', failureCode: failure, updatedAt: this.clock.now(),
        log: row.log + '\n' + (error instanceof Error && !(error instanceof BusinessRuleError) ? error.message : 'Installation failed. Nothing was written.') }))
    }
  }
  private startUninstall(id: string, restore: SuiteInstallRecord['status']): void {
    if (this.jobs.has(id)) return
    const job = this.runUninstall(id, restore).finally(() => this.jobs.delete(id))
    this.jobs.set(id, job); void job.catch(() => {})
  }
  private async runUninstall(id: string, restore: SuiteInstallRecord['status']): Promise<void> {
    const record = this.store.read().installs.find(row => row.id === id)
    if (!record) return
    try {
      for (const entry of record.entries) await this.operationsFor(entry.kind).uninstall(entry, suiteInstallOrigin(id))
      this.write(state => ({ ...state, installs: state.installs.filter(item => item.id !== id) }))
    } catch (error) {
      this.saveRecord(id, row => ({ ...row, status: restore, updatedAt: this.clock.now(), log: row.log + '\nUninstall failed: ' + (error instanceof Error ? error.message : 'unknown failure') }))
    }
  }
  private available(entry: SuiteCatalogEntry): boolean {
    return entry.items.every(item => this.operationsFor(item.kind).available(item))
  }
  private operationsFor(kind: SuiteCatalogItem['kind'] | SuiteInstalledEntry['kind']): SuiteItemOperations<SuiteCatalogItem, unknown> {
    if (kind === 'runtime-dependency') return this.runtimeDependencyKind as SuiteItemOperations<SuiteCatalogItem, unknown>
    throw new BusinessRuleError('invalid', 'Unsupported suite entry kind.', 'suite-catalog-invalid')
  }
  private require(id: string): SuiteCatalogEntry {
    const entry = this.presets.find(row => row.id === id)
    if (!entry) throw new BusinessRuleError('missing', 'This catalog entry does not exist.', 'suite-not-found')
    return entry
  }
  private requireInstalled(id: string): SuiteInstallRecord {
    const record = this.store.read().installs.find(row => row.id === id)
    if (!record || record.status === 'installing' || record.status === 'uninstalling') throw new BusinessRuleError(record ? 'conflict' : 'missing',
      record ? 'A task is already running for this entry.' : 'This catalog entry is not installed.',
      record ? 'suite-task-running' : 'suite-not-installed')
    return record
  }
  private appendLog(id: string, line: string): Promise<void> {
    this.saveRecord(id, row => ({ ...row, log: row.log + '\n' + line }))
    return Promise.resolve()
  }
  private saveRecord(id: string, update: (row: SuiteInstallRecord) => SuiteInstallRecord): void {
    this.write(state => ({ ...state, installs: state.installs.map(row => row.id === id ? update(row) : row) }))
  }
  private write(update: (state: SuiteInstallState) => SuiteInstallState): void { this.store.write(update(this.store.read())) }
  private view(row: SuiteInstallRecord): CommunitySuiteInstallView {
    return { id: row.id, version: row.version, status: row.status, entries: row.entries, updatedAt: row.updatedAt, log: row.log }
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required.', 'admin-required')
  }
}
