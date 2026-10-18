import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { CommunitySuiteCatalogView, CommunitySuiteInstallPreview, CommunitySuiteInstallView, CommunitySuiteUninstallPreview, CommunitySuiteUpdatePreview } from '../domain/admin-contract.js'
import { suiteCatalogRefusal, suiteInstallInput, type SuiteCatalogArchitecture, type SuiteCatalogEntryUnavailable, type SuiteCatalogItem, type SuiteCatalogItemKind, type SuiteCatalogRuntimeDependencyItem, type SuiteCatalogExecutionItem, type SuiteCatalogEntry, type SuiteInstallRequest, invalidRequest, suiteCredentialsInput, suiteUninstallInput } from '../domain/suite-catalog.js'
import { compareSuiteVersions, suiteExecutionOwner, suiteInstallOrigin, type SuiteInstalledEntry, type SuiteInstallRecord, type SuiteInstallState, type SuiteReplacementSnapshot } from '../domain/suite-install.js'
import { RuntimeDependencyPreparationFailure } from '../domain/runtime-dependency.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { Clock } from '../ports/clock.js'
import type { SuiteInstallStorePort } from '../ports/suite-catalog.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import { credentialsFor, ExecutionSuiteKind, RuntimeDependencySuiteKind, SkillPackSuiteKind, SkillSuiteKind, type ExecutionSuitePort, type SkillPackSuitePort, type SkillSuitePort, type SuiteCommitContext, type SuiteItemOperations, type SuiteItemPlan, type SuiteReplacementPlan } from './suite-entry-kinds.js'
import { planReplacements, replacementBusy, replacementConfirmed, replacementEntries, type SuiteReplacements } from './suite-replacements.js'
import { SuiteUpdates, type SuiteUpdateContext } from './suite-updates.js'
import type { ExecutionSuiteUpdatePort, SkillPackSuiteUpdatePort, SkillSuiteUpdatePort } from './suite-entry-kinds.js'
import type { SuiteCatalogGallery } from './suite-catalog-gallery.js'

export type { ExecutionSuitePort, SkillPackSuitePort, SkillSuitePort } from './suite-entry-kinds.js'

interface PreparedJob { readonly operations: SuiteItemOperations<SuiteCatalogItem, unknown>, readonly item: SuiteCatalogItem, readonly plan: SuiteItemPlan, readonly value: unknown, readonly unit: string }
/** Committed library names keyed by owning catalog id and catalog item name. */
const committedKey = (unit: string, item: string): string => `${unit}\0${item}`
/** A shared catalog dependency this suite install brings into the library, with the record it replaced. */
interface DependencyInstall { readonly entry: SuiteCatalogEntry, readonly previous?: SuiteInstallRecord }

/** Plans and runs suite catalog installs; library rows appear only after every step succeeded. */
export class SuiteCatalog {
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly shutdown = new AbortController()
  private readonly runtimeDependencyKind: RuntimeDependencySuiteKind
  private readonly skillKind: SkillSuiteKind
  private readonly skillPackKind: SkillPackSuiteKind
  private readonly executionKind: ExecutionSuiteKind
  private readonly updates?: SuiteUpdates
  constructor(private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>, private readonly presets: readonly SuiteCatalogEntry[], private readonly store: SuiteInstallStorePort,
    private readonly dependencies: RuntimeDependencies, private readonly clock: Clock, architecture: SuiteCatalogArchitecture,
    private readonly skills: SkillSuitePort, private readonly packs: SkillPackSuitePort, private readonly execution?: ExecutionSuitePort,
    private readonly gallery?: Pick<SuiteCatalogGallery, 'entries' | 'source' | 'load'>) {
    this.runtimeDependencyKind = new RuntimeDependencySuiteKind(dependencies, () => architecture, () => this.shutdown.signal)
    this.skillKind = new SkillSuiteKind(skills, () => this.shutdown.signal, packs)
    this.skillPackKind = new SkillPackSuiteKind(packs)
    this.executionKind = new ExecutionSuiteKind(execution)
    // Updates need the full stores; install-only test doubles leave them out.
    if (isUpdatePort<SkillSuiteUpdatePort>(skills, 'commitSuiteUpdate') && isUpdatePort<SkillPackSuiteUpdatePort>(packs, 'updateSuitePack') && (!execution || isUpdatePort<ExecutionSuiteUpdatePort>(execution, 'updateSuiteExecution')))
      this.updates = new SuiteUpdates(dependencies, architecture, () => this.shutdown.signal, skills, packs, execution as ExecutionSuiteUpdatePort | undefined)
    // Replaced manual skills must keep their artifacts until the takeover settles.
    // Rows a pending takeover or update may restore keep their artifacts until the task settles.
    skills.retainSuiteArtifacts?.(() => this.store.read().installs.flatMap(row => [...row.replacing?.skills ?? [], ...row.updating?.skills ?? [], ...row.updating?.pack?.note ? [row.updating.pack.note] : []].map(skill => skill.hash)))
    dependencies.retainReplaced(() => this.store.read().installs.flatMap(row => [...row.replacing?.dependencies ?? [], ...row.updating?.dependencyRows ?? []].flatMap(next => [next.current?.id, next.previous?.id].filter((id): id is string => !!id))))
  }
  catalog(actor: CommunityAccountActor): CommunitySuiteCatalogView {
    this.assertAdmin(actor)
    const state = this.store.read()
    return {
      entries: this.entries().map(entry => {
        const record = state.installs.find(row => row.id === entry.id)
        const suite = entry.category === 'suite' ? entry : undefined
        const packName = suite?.items.find(item => item.kind === 'skill-pack')?.name
        return { id: entry.id, category: entry.category, title: entry.title, description: entry.description, source: entry.source, version: entry.version,
          commands: [...new Set(entry.items.flatMap(item => item.kind === 'runtime-dependency' ? item.commands : []))], available: this.available(entry), ...this.unavailableReason(entry), ...(entry.unavailableDetail ? { unavailableDetail: entry.unavailableDetail } : {}),
          ...(suite ? { identity: suite.identity, skills: suite.items.flatMap(item => item.kind === 'skill' ? item.names : []) } : {}),
          ...(packName !== undefined ? { packName } : {}),
          ...(suite?.dependencies.length ? { dependencies: suite.dependencies } : {}), ...(suite?.serviceAddresses?.length ? { serviceAddresses: suite.serviceAddresses } : {}),
          ...(this.executionItems(entry).length ? { execution: { commands: this.executionItems(entry).flatMap(item => item.delegated), variables: this.executionItems(entry).flatMap(item => item.variables) } } : {}),
          ...(record ? { installedVersion: record.version, ...(record.status === 'installed' && compareSuiteVersions(entry.version, record.version) > 0 ? { updateAvailable: true } : {}) } : {}) }
      }),
      installations: state.installs.map(row => this.view(row)),
      source: this.gallery?.source() ?? { status: 'ok', address: '' },
    }
  }
  /** Fetches the online catalog for one gallery view; the route awaits this before reading entries. */
  async refreshCatalog(actor: CommunityAccountActor): Promise<void> { this.assertAdmin(actor); await this.gallery?.load() }
  installPreview(actor: CommunityAccountActor, id: string): CommunitySuiteInstallPreview {
    this.assertAdmin(actor)
    const entry = this.require(id), record = this.store.read().installs.find(row => row.id === id)
    const available = this.available(entry)
    const conflicts = this.skills.suiteSkillConflicts(suiteInstallOrigin(id), entry.items.flatMap(item => item.kind === 'skill' ? item.names : []))
    const commandConflicts = this.commandConflicts(entry)
    const shared = this.sharedDependencies(entry), plan = this.replacements(entry), packConflicts = this.packConflicts(entry)
    const skillConflicts = conflicts.filter(name => !plan.skills.some(row => row.name === name))
    const dependencyConflicts = [...new Set([...plan.conflicts, ...shared.conflicts])]
    const reason = record?.status === 'installed' ? 'already-installed' as const
      : record && record.status !== 'failed' || shared.busy || replacementBusy(plan, this.store.read().installs) ? 'task-running' as const
      : shared.missing.length ? 'dependency-missing' as const
      : entry.unavailableReason ?? (!available ? 'unavailable-architecture' as const : undefined)
        ?? (skillConflicts.length ? 'skill-conflicts' as const : dependencyConflicts.length ? 'dependency-conflicts' as const : packConflicts.length ? 'pack-conflicts' as const : commandConflicts.length ? 'command-conflicts' as const : undefined)
    const creates = reason === undefined ? entry.items.map(item => { const plan = this.operationsFor(item.kind).plan(item)
      return { kind: item.kind, name: plan.name, ...(plan.commands ? { commands: plan.commands } : {}), ...(plan.detail ? { detail: plan.detail } : {}) } }) : []
    const dependencies = [...shared.install.map(row => ({ id: row.entry.id, action: 'install' as const })), ...shared.reuse.map(id => ({ id, action: 'reuse' as const })),
      ...shared.manual.map(row => ({ id: row.id, action: 'manual' as const, name: row.name }))]
    const replacements = replacementEntries(plan)
    return { id, version: entry.version, available, ...(reason ? { reason } : {}), creates, ...(skillConflicts.length ? { conflicts: skillConflicts } : {}), ...(commandConflicts.length ? { commandConflicts } : {}),
      ...(shared.missing.length ? { missingDependencies: shared.missing } : {}),
      ...(dependencies.length ? { dependencies } : {}), ...(replacements.length ? { replacements } : {}), ...(dependencyConflicts.length ? { dependencyConflicts } : {}), ...(packConflicts.length ? { packConflicts } : {}) }
  }
  uninstallPreview(actor: CommunityAccountActor, id: string): CommunitySuiteUninstallPreview {
    this.assertAdmin(actor)
    const record = this.requireInstalled(id)
    const blocked = this.blockedReferences(record).map(block => ({ name: block.owner, references: block.references }))
    const impact = record.entries.flatMap(entry => { const pack = entry.kind === 'skill-pack' ? this.packs.suiteImpact(entry.name) : undefined; return pack ? [{ name: entry.name, ...pack }] : [] })
    return { id, removes: record.entries, blocked, impact, dependencies: this.dependenciesAfterUninstall(record) }
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
    // A failed install still holding originals must restore them (on the next restart) before a retry may replace them again.
    if (previous?.replacing) throw new BusinessRuleError('conflict', 'A task is already running for this entry.', 'suite-task-running')
    if (previous && previous.status !== 'failed') throw new BusinessRuleError('conflict',
      previous.status === 'installed' ? 'This catalog entry is already installed.' : 'A task is already running for this entry.',
      previous.status === 'installed' ? 'suite-already-installed' : 'suite-task-running')
    if (entry.unavailableReason) throw suiteCatalogRefusal(entry.unavailableReason)
    if (!this.available(entry)) throw new BusinessRuleError('invalid', 'This suite entry has no preparation for the current architecture.', 'suite-arch-unavailable')
    const variables = new Set(this.executionItems(entry).flatMap(item => item.variables.map(row => row.name)))
    if (Object.keys(value.credentials ?? {}).some(name => !variables.has(name))) throw invalidRequest()
    const plan = this.replacements(entry), shared = this.sharedDependencies(entry)
    if (shared.missing.length) throw new BusinessRuleError('missing', 'A shared catalog dependency is not available right now.', 'suite-dependency-missing')
    if (plan.conflicts.length || shared.conflicts.length) throw new BusinessRuleError('conflict', 'Other dependencies already provide these commands.', 'suite-dependency-conflict')
    if (this.packConflicts(entry).length) throw new BusinessRuleError('invalid', 'Review the skill pack name and selected skills.', 'skill-pack-invalid')
    if (this.commandConflicts(entry).length) throw new BusinessRuleError('conflict', 'A command name is already delegated by another owner.', 'execution-config-invalid')
    if (this.skills.suiteSkillConflicts(suiteInstallOrigin(value.id), entry.items.flatMap(item => item.kind === 'skill' ? item.names : [])).some(name => !plan.skills.some(row => row.name === name))) throw new BusinessRuleError('conflict', 'A skill with this name already exists with a different origin.', 'suite-skill-conflict')
    if (shared.busy || replacementBusy(plan, state.installs)) throw new BusinessRuleError('conflict', 'A task is already running for this entry.', 'suite-task-running')
    if (!replacementConfirmed(plan, value.replace)) throw new BusinessRuleError('conflict', 'Confirm replacing the manual entries listed in the preview.', 'suite-replace-unconfirmed')
    // Declaring dependencies on the record up front makes an in-flight install count as their user.
    const snapshot = this.replacementSnapshot(entry, plan)
    const record: SuiteInstallRecord = { id: entry.id, version: entry.version, status: 'installing', category: entry.category, ...(entry.contentHash ? { contentHash: entry.contentHash } : {}), entries: [], requestId: value.requestId, updatedAt: this.clock.now(),
      ...(entry.category === 'suite' && entry.dependencies.length ? { dependencies: entry.dependencies } : {}),
      ...(shared.manual.length ? { manualDependencies: shared.manual } : {}), ...(snapshot ? { replacing: snapshot } : {}),
      log: `${previous?.log ? previous.log + '\n---\n' : ''}Installing ${entry.id} ${entry.version}…` }
    // Missing shared dependencies join this task; their own records stay busy until it ends.
    const dependencyRecords = shared.install.map(({ entry: dependency, previous: old }): SuiteInstallRecord => ({ id: dependency.id, version: dependency.version, category: dependency.category,
      ...(dependency.contentHash ? { contentHash: dependency.contentHash } : {}), status: 'installing', entries: [], updatedAt: this.clock.now(),
      log: `${old?.log ? old.log + '\n---\n' : ''}Installing ${dependency.id} ${dependency.version} for ${entry.id}…` }))
    const replaced = new Set([entry.id, ...dependencyRecords.map(row => row.id)])
    this.write(next => ({ ...next, requests: [...next.requests ?? [], value.requestId].slice(-200), installs: [...next.installs.filter(item => !replaced.has(item.id)), ...dependencyRecords, record] }))
    this.startInstall(entry, value, shared.install, plan)
    return this.view(record)
  }
  /** Fills in or replaces team credentials after install; blank values keep what was saved. */
  async saveCredentials(actor: CommunityAccountActor, id: string, input: unknown): Promise<void> {
    this.assertAdmin(actor)
    const record = this.requireInstalled(id), entry = this.require(id), credentials = suiteCredentialsInput(input)
    const items = this.executionItems(entry).filter(item => record.entries.some(row => row.kind === 'execution' && row.name === item.skill))
    if (!items.length || !this.execution || Object.keys(credentials).some(name => !items.some(item => item.variables.some(row => row.name === name)))) throw invalidRequest()
    for (const item of items) await this.execution.saveSuiteCredentials(suiteInstallOrigin(id), suiteExecutionOwner(item.skill), credentialsFor(item, credentials))
  }
  uninstall(actor: CommunityAccountActor, id: string, input?: unknown): void {
    this.assertAdmin(actor)
    const record = this.requireInstalled(id), request = suiteUninstallInput(input)
    const blocked = this.blockedReferences(record).flatMap(block => block.references)
    if (blocked.length) throw new BusinessRuleError('conflict', 'Suite entries are still referenced.', 'runtime-dependency-referenced', { references: blocked.map(reference => `${reference.kind}: ${reference.name}`).join(', ') })
    if ((request.removeDependencies ?? []).some(dependency => !(record.dependencies ?? []).includes(dependency))) throw invalidRequest()
    const kept = this.dependenciesAfterUninstall(record).filter(row => row.references.length && request.removeDependencies?.includes(row.id))
    if (kept.length) throw new BusinessRuleError('conflict', 'Suite entries are still referenced.', 'runtime-dependency-referenced', { references: kept.flatMap(row => row.references.map(reference => `${reference.kind}: ${reference.name}`)).join(', ') })
    this.saveRecord(id, row => ({ ...row, status: 'uninstalling', updatedAt: this.clock.now(), log: row.log + '\nUninstalling…' }))
    this.startUninstall(record.id, record.status, request.removeDependencies ?? [])
  }
  /** Detached entries leave the install record, so updates and uninstall no longer touch them. */
  async detach(actor: CommunityAccountActor, id: string, input: unknown): Promise<void> {
    this.assertAdmin(actor)
    const record = this.requireInstalled(id)
    if (this.busyDependents(id).length) throw new BusinessRuleError('conflict', 'A task is already running for this entry.', 'suite-task-running')
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => key !== 'kind' && key !== 'name')) throw invalidRequest()
    const { kind, name } = input as { kind?: unknown, name?: unknown }
    const entry = record.entries.find(row => row.kind === kind && row.name === name)
    if (!entry) throw new BusinessRuleError('missing', 'This entry is not part of the suite.', 'suite-entry-missing')
    // A delegated execution configuration belongs to its skill, so a detached skill takes it along.
    const entries = [entry, ...entry.kind === 'skill' ? record.entries.filter(row => row.kind === 'execution' && row.name === entry.name) : []]
    // The record leaves the installed state first so no install or uninstall starts while library rows change.
    this.saveRecord(id, row => ({ ...row, status: 'detaching', updatedAt: this.clock.now() }))
    try { for (const next of entries) await this.operationsFor(next.kind).detach(next, suiteInstallOrigin(id)) }
    finally {
      this.saveRecord(id, row => ({ ...row, status: 'installed', entries: row.entries.filter(next => !entries.some(gone => gone.kind === next.kind && gone.name === next.name)), detached: [...row.detached ?? [], ...entries.filter(next => !row.detached?.some(gone => gone.kind === next.kind && gone.name === next.name))], updatedAt: this.clock.now(),
        log: row.log + entries.map(next => `\nDetached ${next.kind} ${next.name}.`).join('') }))
    }
  }
  /** Interrupted tasks carry no in-memory job after a restart; committed rows are rolled back here. */
  async recover(): Promise<void> {
    // Suites first: their skills reference shared dependencies, which can only be removed afterwards.
    const order = (row: SuiteInstallRecord) => (row.category ?? this.entries().find(entry => entry.id === row.id)?.category) === 'dependency' ? 1 : 0
    for (const row of [...this.store.read().installs].sort((a, b) => order(a) - order(b))) {
      if (this.jobs.has(row.id)) continue
      if (row.status === 'failed' && row.replacing) {
        // An earlier restore did not finish; the originals are still on the record and its rows were kept for them.
        if (await this.restoreReplaced(row.id)) {
          await this.cleanup(row.id).catch(() => {}); this.saveRecord(row.id, withoutReplacing)
          // Shared dependencies that failed with it kept their rows for the suite skills; those are gone now.
          for (const id of row.dependencies ?? []) {
            const shared = this.store.read().installs.find(item => item.id === id)
            if (shared?.status === 'failed' && shared.entries.length) await this.cleanup(id).then(() => this.saveRecord(id, item => ({ ...item, entries: [] })), () => {})
          }
        }
      } else if (row.status === 'installing') {
        const restored = await this.restoreReplaced(row.id)
        if (restored) await this.cleanup(row.id).catch(() => {})
        await this.skills.discardSuiteImport(row.id).catch(() => {})
        this.saveRecord(row.id, record => ({ ...restored ? withoutReplacing(record) : record, status: 'failed', failureCode: 'interrupted', updatedAt: this.clock.now(), log: record.log + '\nInstallation was interrupted. Retry to install again.' }))
      } else if (row.status === 'updating') {
        if (row.settling) await this.finishUpdate(row.id, row.settling)
        else await this.restoreUpdate(row.id, 'Update was interrupted; the previous version is in use. Update again to retry.')
      } else if (row.status === 'detaching') {
        this.saveRecord(row.id, record => ({ ...record, status: 'installed', updatedAt: this.clock.now(), log: record.log + '\nDetaching was interrupted; detach the entry again to finish.' }))
      } else if (row.status === 'uninstalling') {
        // Keep the record when removal is blocked so the administrator can still uninstall later.
        const removed = await this.cleanup(row.id).then(() => true, () => false)
        if (removed) this.write(state => ({ ...state, installs: state.installs.filter(item => item.id !== row.id) }))
        else this.saveRecord(row.id, record => ({ ...record, status: 'installed', updatedAt: this.clock.now(), log: record.log + '\nUninstall was interrupted and is still referenced. Remove the references and uninstall again.' }))
      }
    }
  }
  updatePreview(actor: CommunityAccountActor, id: string): CommunitySuiteUpdatePreview {
    this.assertAdmin(actor)
    const record = this.store.read().installs.find(row => row.id === id), entry = this.require(id)
    if (!record || record.status === 'failed') return { id, from: record?.version ?? '', to: entry.version, reason: 'not-installed', skills: { added: [], removed: [], updated: [] }, dependents: [], skipped: [], manualDependencies: [] }
    if (entry.unavailableReason) return { id, from: record.version, to: entry.version, reason: entry.unavailableReason, skills: { added: [], removed: [], updated: [] }, dependents: [], skipped: [], manualDependencies: [] }
    const preview = this.requireUpdates().preview(this.updateContext(record, entry))
    return record.status === 'installed' && !this.busyDependents(id).length ? preview : { ...preview, reason: 'task-running' }
  }
  /** Platform upgrades only offer updates; the installed version keeps running until this task switched every step. */
  update(actor: CommunityAccountActor, id: string): CommunitySuiteInstallView {
    this.assertAdmin(actor)
    const record = this.requireInstalled(id), entry = this.require(id), updates = this.requireUpdates()
    if (entry.unavailableReason) throw suiteCatalogRefusal(entry.unavailableReason)
    if (record.status !== 'installed' || this.busyDependents(id).length) throw new BusinessRuleError('conflict', 'A task is already running for this entry.', 'suite-task-running')
    const preview = updates.preview(this.updateContext(record, entry))
    if (preview.reason) throw new BusinessRuleError(preview.reason === 'up-to-date' ? 'conflict' : 'invalid', 'This entry cannot be updated now.',
      preview.reason === 'up-to-date' ? 'suite-up-to-date' : preview.reason === 'dependency-missing' ? 'suite-dependency-missing' : preview.reason === 'skill-conflicts' ? 'suite-skill-conflict' : 'suite-arch-unavailable')
    const snapshot = updates.snapshot(record)
    this.saveRecord(id, row => ({ ...row, status: 'updating', updating: snapshot, updatedAt: this.clock.now(), log: `${row.log}\n---\nUpdating ${id} ${row.version} → ${entry.version}…` }))
    if (!this.jobs.has(id)) {
      const job = this.runUpdate(entry).finally(() => this.jobs.delete(id))
      this.jobs.set(id, job); void job.catch(() => {})
    }
    return this.view(this.store.read().installs.find(row => row.id === id)!)
  }
  async stop(): Promise<void> {
    this.shutdown.abort()
    await Promise.allSettled([...this.jobs.values()])
  }
  private startInstall(entry: SuiteCatalogEntry, options: SuiteInstallRequest, dependencies: readonly DependencyInstall[], replacements: SuiteReplacements): void {
    if (this.jobs.has(entry.id)) return
    const job = this.runInstall(entry, options, dependencies, replacements).finally(() => this.jobs.delete(entry.id))
    this.jobs.set(entry.id, job); void job.catch(() => {})
  }
  private async runInstall(entry: SuiteCatalogEntry, options: SuiteInstallRequest, dependencies: readonly DependencyInstall[], replacements: SuiteReplacements): Promise<void> {
    const snapshot = this.store.read().installs.find(row => row.id === entry.id)?.replacing
    const replacement: SuiteReplacementPlan = { dependencies: new Map(replacements.dependencies.map(row => [row.item, row.row])), skills: replacements.skills, executions: snapshot?.executions ?? [] }
    const prepared: PreparedJob[] = []
    const log = (line: string) => this.appendLog(entry.id, line)
    // Shared dependencies prepare and commit first, under their own catalog origin, so suite skills can reference them.
    const units = [...dependencies.map(row => row.entry), entry]
    const names = new Map<string, string>(), installed = new Map<string, SuiteInstalledEntry[]>()
    try {
      for (const unit of units) for (const item of unit.items) {
        const operations = this.operationsFor(item.kind)
        const plan = operations.plan(item)
        prepared.push({ operations, item, plan, unit: unit.id, value: await operations.prepare(item, plan, suiteInstallOrigin(unit.id), log, unit.id === entry.id ? replacement : undefined) })
        await log(`${plan.name} prepared.`)
      }
      await log('Writing library entries…')
      for (const job of prepared) {
        const context: SuiteCommitContext = { request: options, dependencyName: item => names.get(committedKey(job.unit, item)) ?? item,
          catalogDependencyNames: ids => ids.map(id => this.catalogDependencyName(id, names, this.store.read().installs.find(row => row.id === entry.id)?.manualDependencies)), ...(job.unit === entry.id ? { replacement } : {}) }
        const entries = await job.operations.commit(job.item, job.plan, job.value, suiteInstallOrigin(job.unit), context)
        if (job.item.kind === 'runtime-dependency' && entries[0]) names.set(committedKey(job.unit, job.item.name), entries[0].name)
        installed.set(job.unit, [...installed.get(job.unit) ?? [], ...entries])
        this.saveRecord(job.unit, row => ({ ...row, entries: [...row.entries, ...entries.filter(next => !row.entries.some(previous => previous.kind === next.kind && previous.name === next.name))] }))
      }
      for (const unit of units) this.saveRecord(unit.id, row => {
        const { failureCode, replacing, ...record } = row; void failureCode
        const replaced = replacing ? [...replacing.dependencies.map(next => ({ kind: 'runtime-dependency' as const, name: next.name })), ...replacing.skills.map(next => ({ kind: 'skill' as const, name: next.name }))] : []
        return { ...record, status: 'installed', version: unit.version, entries: installed.get(unit.id) ?? [], ...(replaced.length ? { replaced } : {}), updatedAt: this.clock.now(),
          ...(unit.id !== entry.id ? { log: record.log + `\nInstalled with ${entry.id}.` } : {}) }
      })
      // A catalog dependency that took over a manual twin is no longer a manual dependency of the suites reusing it.
      const ids = new Set(units.map(unit => unit.id))
      this.write(state => ({ ...state, installs: state.installs.map(row => row.manualDependencies?.some(next => ids.has(next.id)) ? withoutManual(row, ids) : row) }))
      // Only after the record no longer holds originals: a crash in between leaves extra values, never a lost configuration.
      if (snapshot) await this.execution?.finalizeSuiteExecutions(suiteInstallOrigin(entry.id), this.executionItems(entry).map(item => ({ owner: suiteExecutionOwner(item.skill), variables: item.variables.map(row => row.name) }))).catch(() => {})
      await log('Installed.')
      const packName = installed.get(entry.id)?.find(next => next.kind === 'skill-pack')?.name
      if (packName !== undefined && (options.publish === true || options.groups?.length)) {
        await log('Applying grant and publication choices…')
        try {
          await this.packs.applySuiteOptions(packName, { ...(options.publish !== undefined ? { publish: options.publish } : {}), ...(options.groups !== undefined ? { groups: options.groups } : {}) })
          await log('Grants and publication applied.')
        } catch (error) {
          await log('Grant/publication step failed: ' + (error instanceof Error ? error.message : 'unknown failure'))
        }
      }
    } catch (error) {
      // Originals go back first: their rows no longer carry this origin, so the cleanup below cannot remove them,
      // and a replaced delegated execution can still take its saved values from the suite configuration.
      const restored = await this.restoreReplaced(entry.id)
      // Suite execution configurations hold the saved values a pending restore still needs.
      for (const job of [...prepared].reverse()) if (restored || job.item.kind !== 'execution') await job.operations.rollback(suiteInstallOrigin(job.unit)).catch(() => {})
      // A failure after the first commit leaves owned rows behind; remove every origin of this task again, suite first.
      // Rows still waiting to be restored stay until recovery has put the originals back.
      for (const unit of [...units].reverse()) if (restored || unit.id !== entry.id) await this.cleanup(unit.id).catch(() => {})
      const failure = error instanceof RuntimeDependencyPreparationFailure || error instanceof BusinessRuleError ? error.code : 'prepare-failed'
      // With originals still pending, shared dependency rows the suite skills reference may remain; their records stay failed
      // so recovery removes them after the suite.
      for (const dependency of dependencies) {
        if (restored) this.restoreDependencyRecord(dependency, `Install with ${entry.id} failed; nothing was kept.`)
        else this.saveRecord(dependency.entry.id, row => ({ ...row, status: 'failed', failureCode: 'interrupted', updatedAt: this.clock.now(), log: row.log + `\nInstall with ${entry.id} failed; removal waits for its restore.` }))
      }
      this.saveRecord(entry.id, row => ({ ...restored ? withoutReplacing(row) : row, status: 'failed', failureCode: failure, entries: [], updatedAt: this.clock.now(),
        log: row.log + '\n' + (error instanceof Error && !(error instanceof BusinessRuleError) ? error.message : 'Installation failed. Nothing was written.') }))
    }
  }
  private async runUpdate(entry: SuiteCatalogEntry): Promise<void> {
    const record = this.store.read().installs.find(row => row.id === entry.id)!
    try {
      const entries = await this.requireUpdates().run(this.updateContext(record, entry), line => this.appendLog(entry.id, line), assignments => this.saveRecord(entry.id, row => ({ ...row, updating: { ...row.updating!, assignments } })))
      const settling = this.requireUpdates().settlement(entry, record)
      this.saveRecord(entry.id, row => { const { updating, failureCode, ...rest } = row; void updating; void failureCode
        return { ...rest, status: 'updating', settling, version: entry.version, category: entry.category, ...(entry.contentHash ? { contentHash: entry.contentHash } : {}), entries, manualDependencies: (row.manualDependencies ?? []).filter(next => entry.category === 'suite' && entry.dependencies.includes(next.id)), dependencies: entry.category === 'suite' ? entry.dependencies : [], updatedAt: this.clock.now(), log: row.log + `\nUpdated to ${entry.version}.` } })
      await this.finishUpdate(entry.id, settling)
    } catch (error) {
      await this.restoreUpdate(entry.id, 'Update failed; the previous version is still in use. ' + (error instanceof Error && !(error instanceof BusinessRuleError) ? error.message : ''), error instanceof RuntimeDependencyPreparationFailure || error instanceof BusinessRuleError ? error.code : 'prepare-failed')
    }
  }
  private async finishUpdate(id: string, settling: NonNullable<SuiteInstallRecord['settling']>): Promise<void> {
    try { await this.requireUpdates().settle(id, settling) }
    catch { this.saveRecord(id, row => ({ ...row, log: row.log + '\nCleanup pending; restart to retry.' })); return }
    this.saveRecord(id, row => { const { settling: done, ...rest } = row; void done; return { ...rest, status: 'installed' } })
  }
  /** Switches back to the version an update found; the record returns to installed with that version. */
  private async restoreUpdate(id: string, note: string, failureCode = 'interrupted'): Promise<void> {
    const snapshot = this.store.read().installs.find(row => row.id === id)?.updating
    if (snapshot) {
      try { await this.requireUpdates().restore(id, snapshot) }
      catch {
        this.saveRecord(id, row => ({ ...row, failureCode, log: row.log + '\nRecovery failed; the update snapshot is retained. Restart to retry recovery.' }))
        return
      }
    }
    this.saveRecord(id, row => { const { updating, ...rest } = row; void updating
      return { ...rest, status: 'installed', ...(snapshot ? { version: snapshot.version, contentHash: snapshot.contentHash, entries: snapshot.entries } : {}), failureCode, updatedAt: this.clock.now(), log: row.log + '\n' + note.trim() } })
  }
  private updateContext(record: SuiteInstallRecord, entry: SuiteCatalogEntry): SuiteUpdateContext {
    const installs = this.store.read().installs
    return { record, entry, installs, catalogDependencyName: id => {
      const manual = record.manualDependencies?.find(row => row.id === id)
      if (manual) return manual.name
      const shared = installs.find(row => row.id === id && row.status === 'installed')
      return shared?.entries.find(row => row.kind === 'runtime-dependency')?.name
    } }
  }
  private requireUpdates(): SuiteUpdates {
    if (!this.updates) throw new BusinessRuleError('invalid', 'Updates are unavailable.', 'suite-catalog-invalid')
    return this.updates
  }
  private startUninstall(id: string, restore: SuiteInstallRecord['status'], removeDependencies: readonly string[] = []): void {
    if (this.jobs.has(id)) return
    const job = this.runUninstall(id, restore, removeDependencies).finally(() => this.jobs.delete(id))
    this.jobs.set(id, job); void job.catch(() => {})
  }
  private async runUninstall(id: string, restore: SuiteInstallRecord['status'], removeDependencies: readonly string[]): Promise<void> {
    const record = this.store.read().installs.find(row => row.id === id)
    if (!record) return
    try {
      await this.cleanup(id)
      this.write(state => ({ ...state, installs: state.installs.filter(item => item.id !== id) }))
    } catch (error) {
      this.saveRecord(id, row => ({ ...row, status: restore, updatedAt: this.clock.now(), log: row.log + '\nUninstall failed: ' + (error instanceof Error ? error.message : 'unknown failure') }))
      return
    }
    // Chosen shared dependencies go only when nothing references them any more; otherwise they stay installed.
    for (const dependency of removeDependencies) {
      const shared = this.store.read().installs.find(row => row.id === dependency && row.status === 'installed')
      if (!shared || this.blockedReferences(shared).length) continue
      // Marked busy in the same tick as the reference check, so a concurrent install cannot choose to reuse it.
      this.saveRecord(dependency, row => ({ ...row, status: 'uninstalling', updatedAt: this.clock.now(), log: row.log + `\nUninstalling with ${id}…` }))
      try { await this.cleanup(dependency); this.write(state => ({ ...state, installs: state.installs.filter(item => item.id !== dependency) })) }
      catch (error) { this.saveRecord(dependency, row => ({ ...row, status: 'installed', updatedAt: this.clock.now(), log: row.log + `\nRemoval with ${id} failed: ` + (error instanceof Error ? error.message : 'unknown failure') })) }
    }
  }
  /** References from entries this same install owns are removed together and never block the uninstall. */
  private ownedReferences(record: SuiteInstallRecord): ReadonlySet<string> {
    return new Set(record.entries.flatMap(entry => entry.kind === 'skill' ? [`skill:${entry.name}`] : entry.kind === 'execution' ? [`execution:${suiteExecutionOwner(entry.name)}`] : []))
  }
  /** References that keep this install's entries in place: library consumers outside it, plus other suites that declare it. `leaving` is an install treated as already gone. */
  private blockedReferences(record: SuiteInstallRecord, leaving?: SuiteInstallRecord): readonly { owner: string, references: readonly { kind: string, name: string }[] }[] {
    const owned = new Set([...this.ownedReferences(record), ...leaving ? this.ownedReferences(leaving) : []])
    const blocking: { owner: string, references: { kind: string, name: string }[] }[] = []
    for (const entry of record.entries) {
      const references = this.operationsFor(entry.kind).references(entry).filter(reference => !owned.has(`${reference.kind}:${reference.name}`))
      if (references.length) blocking.push({ owner: entry.name, references })
    }
    const suites = this.store.read().installs.filter(row => row.id !== leaving?.id && row.id !== record.id && row.status !== 'failed' && row.dependencies?.includes(record.id))
    if (suites.length) blocking.push({ owner: record.id, references: suites.map(row => ({ kind: 'suite', name: row.id })) })
    return blocking
  }
  /** Removes every library row this install owns: pack, delegated execution, skills, then the runtime dependency. */
  private cleanup(id: string): Promise<void> {
    const origin = suiteInstallOrigin(id)
    return this.packs.removeSuitePack(origin)
      .then(() => this.execution?.removeSuiteExecution(origin))
      .then(() => this.skills.removeSuiteSkills(origin))
      .then(() => this.dependencies.removeManaged(origin))
  }
  private available(entry: SuiteCatalogEntry): boolean {
    return entry.unavailableReason === undefined && entry.items.every(item => this.operationsFor(item.kind).available(item))
      && (entry.category !== 'suite' || this.sharedDependencies(entry).missing.length === 0 && this.sharedDependencies(entry).install.every(row => this.available(row.entry)))
  }
  private entries(): readonly SuiteCatalogEntry[] { return this.gallery?.entries() ?? this.presets }
  /** Why the gallery card cannot install: a signed refusal, otherwise the architecture limit. */
  private unavailableReason(entry: SuiteCatalogEntry): { readonly unavailableReason?: SuiteCatalogEntryUnavailable | 'architecture' | 'dependency-missing' } {
    if (entry.unavailableReason) return { unavailableReason: entry.unavailableReason }
    if (entry.category === 'suite' && this.sharedDependencies(entry).missing.length) return { unavailableReason: 'dependency-missing' }
    return entry.items.every(item => this.operationsFor(item.kind).available(item)) ? {} : { unavailableReason: 'architecture' }
  }
  /** Splits a suite's catalog dependencies into ones to install in its task and ones already in the library. */
  private sharedDependencies(entry: SuiteCatalogEntry): { readonly install: readonly DependencyInstall[], readonly reuse: readonly string[], readonly manual: readonly { id: string, name: string }[], readonly conflicts: readonly string[], readonly missing: readonly string[], readonly busy: boolean } {
    if (entry.category !== 'suite') return { install: [], reuse: [], manual: [], conflicts: [], missing: [], busy: false }
    const installs = this.store.read().installs, install: DependencyInstall[] = [], reuse: string[] = [], manual: { id: string, name: string }[] = [], conflicts: string[] = [], missing: string[] = []
    let busy = false
    for (const id of entry.dependencies) {
      const record = installs.find(row => row.id === id)
      const dependency = this.entries().find(row => row.id === id)
      // Until tickets 06/07 move every suite online, a catalog outage can hide a bundled suite's shared dependencies.
      if (!dependency) { missing.push(id); continue }
      // A manual dependency that already provides every command is used as it is; the catalog copy is not installed.
      const commands = dependency.items.flatMap(item => item.kind === 'runtime-dependency' ? item.commands : [])
      const own = this.dependencies.manualProviders(commands)[0]
      if (record?.status === 'installed') reuse.push(id)
      else if (record && record.status !== 'failed') busy = true
      else if (own) manual.push({ id, name: own.name })
      else {
        // Any other provider (MCP catalog, a manual MCP service, a partial manual twin) would make the commit fail late.
        const blocking = this.dependencies.commandOwners(commands).filter(row => row.managedOrigin !== suiteInstallOrigin(id)).map(row => row.name)
        if (blocking.length) conflicts.push(...blocking)
        else install.push({ entry: dependency, ...(record ? { previous: record } : {}) })
      }
    }
    return { install, reuse, manual, conflicts, missing, busy }
  }
  private packConflicts(entry: SuiteCatalogEntry): readonly string[] {
    return this.packs.suitePackConflicts(suiteInstallOrigin(entry.id), entry.items.flatMap(item => item.kind === 'skill-pack' ? [item.name] : []))
  }
  private replacements(entry: SuiteCatalogEntry): SuiteReplacements {
    return planReplacements(entry, suiteInstallOrigin(entry.id), this.dependencies, this.skills)
  }
  /** Originals of every row the install will take over, captured before the task starts. */
  private replacementSnapshot(entry: SuiteCatalogEntry, plan: SuiteReplacements): SuiteReplacementSnapshot | undefined {
    if (!plan.dependencies.length && !plan.skills.length) return undefined
    const executions = plan.skills.flatMap(row => { const snapshot = this.execution?.suiteExecutionSnapshot(suiteExecutionOwner(row.name)); return snapshot ? [snapshot] : [] })
    void entry
    return { dependencies: plan.dependencies.map(row => row.row), skills: plan.skills, executions }
  }
  /** Puts back every manual row a failed or interrupted install took over; false keeps the originals on the record for another try. */
  private async restoreReplaced(id: string): Promise<boolean> {
    const snapshot = this.store.read().installs.find(row => row.id === id)?.replacing
    if (!snapshot) return true
    try { await this.putBack(id, snapshot); return true } catch { return false }
  }
  private async putBack(id: string, snapshot: SuiteReplacementSnapshot): Promise<void> {
    const origin = suiteInstallOrigin(id)
    for (const row of snapshot.dependencies) this.dependencies.restoreReplaced(origin, row)
    await this.skills.restoreSuiteSkills(origin, snapshot.skills)
    for (const execution of snapshot.executions) await this.execution?.restoreSuiteExecution(origin, execution)
  }
  /** Library name of a shared catalog dependency, whether this task or an earlier install committed it, or the manual one in use. */
  private catalogDependencyName(id: string, committed: ReadonlyMap<string, string>, manual: readonly { id: string, name: string }[] = []): string {
    const own = manual.find(row => row.id === id)
    if (own) return own.name
    const item = this.require(id).items.find((row): row is SuiteCatalogRuntimeDependencyItem => row.kind === 'runtime-dependency')
    if (!item) throw new BusinessRuleError('invalid', 'This catalog dependency defines no runtime dependency.', 'suite-catalog-invalid')
    return committed.get(committedKey(id, item.name))
      ?? this.store.read().installs.find(row => row.id === id)?.entries.find(row => row.kind === 'runtime-dependency')?.name ?? item.name
  }
  /** Shared dependencies of an installed suite with the references that would remain once the suite is gone. */
  private dependenciesAfterUninstall(record: SuiteInstallRecord): readonly { id: string, references: readonly { kind: string, name: string }[] }[] {
    return (record.dependencies ?? []).flatMap(id => {
      const shared = this.store.read().installs.find(row => row.id === id && row.status === 'installed')
      return shared ? [{ id, references: this.blockedReferences(shared, record).flatMap(block => block.references) }] : []
    })
  }
  /** Suites that declare this catalog dependency and are installing or uninstalling right now. */
  private busyDependents(id: string): readonly string[] {
    return this.store.read().installs.filter(row => row.id !== id && row.dependencies?.includes(id) && row.status !== 'installed' && row.status !== 'failed').map(row => row.id)
  }
  /** Removes a shared dependency record that a failed task added, or restores the one it replaced. */
  private restoreDependencyRecord({ entry, previous }: DependencyInstall, note: string): void {
    this.write(state => ({ ...state, installs: previous
      ? state.installs.map(row => row.id === entry.id ? { ...previous, log: previous.log + '\n' + note, updatedAt: this.clock.now() } : row)
      : state.installs.filter(row => row.id !== entry.id) }))
  }
  private operationsFor(kind: SuiteCatalogItemKind | SuiteInstalledEntry['kind']): SuiteItemOperations<SuiteCatalogItem, unknown> {
    if (kind === 'runtime-dependency') return this.runtimeDependencyKind as SuiteItemOperations<SuiteCatalogItem, unknown>
    if (kind === 'skill') return this.skillKind as SuiteItemOperations<SuiteCatalogItem, unknown>
    if (kind === 'skill-pack') return this.skillPackKind as SuiteItemOperations<SuiteCatalogItem, unknown>
    if (kind === 'execution') return this.executionKind as SuiteItemOperations<SuiteCatalogItem, unknown>
    throw new BusinessRuleError('invalid', 'Unsupported suite entry kind.', 'suite-catalog-invalid')
  }
  private commandConflicts(entry: SuiteCatalogEntry): readonly string[] {
    const replacing = this.replacements(entry).skills.map(row => suiteExecutionOwner(row.name))
    return this.executionItems(entry).flatMap(item => this.execution?.delegatedCommandConflicts(suiteExecutionOwner(item.skill), item.delegated.map(row => row.command), replacing) ?? [])
  }
  private executionItems(entry: SuiteCatalogEntry): readonly SuiteCatalogExecutionItem[] { return entry.items.filter((item): item is SuiteCatalogExecutionItem => item.kind === 'execution') }
  private require(id: string): SuiteCatalogEntry {
    const entry = this.entries().find(row => row.id === id)
    if (!entry) throw new BusinessRuleError('missing', 'This catalog entry does not exist.', 'suite-not-found')
    return entry
  }
  private requireInstalled(id: string): SuiteInstallRecord {
    const record = this.store.read().installs.find(row => row.id === id)
    if (!record || record.status !== 'installed' && record.status !== 'failed' || record.replacing) throw new BusinessRuleError(record ? 'conflict' : 'missing',
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
    const missing = row.status === 'installed' ? row.entries.flatMap(entry => entry.kind === 'execution' ? this.execution?.suiteMissingCredentials(suiteExecutionOwner(entry.name)) ?? [] : []) : []
    return { id: row.id, version: row.version, status: row.status, entries: row.entries, updatedAt: row.updatedAt, log: row.log, ...(missing.length ? { missingCredentials: missing } : {}), ...(row.dependencies?.length ? { dependencies: row.dependencies } : {}),
      ...(row.manualDependencies?.length ? { manualDependencies: row.manualDependencies } : {}), ...(row.replaced?.length ? { replaced: row.replaced } : {}) }
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required.', 'admin-required')
  }
}

/** Install records keep replaced originals only while their task runs. */
function withoutReplacing(row: SuiteInstallRecord): SuiteInstallRecord {
  const { replacing, ...rest } = row; void replacing
  return rest
}
function withoutManual(row: SuiteInstallRecord, ids: ReadonlySet<string>): SuiteInstallRecord {
  const { manualDependencies, ...rest } = row
  const kept = (manualDependencies ?? []).filter(next => !ids.has(next.id))
  return kept.length ? { ...rest, manualDependencies: kept } : rest
}
function isUpdatePort<T>(value: object, method: keyof T & string): value is T & object { return typeof (value as Record<string, unknown>)[method] === 'function' }
