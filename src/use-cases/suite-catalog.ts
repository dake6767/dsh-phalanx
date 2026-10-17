import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type { CommunityRuntimeDependencyInput, CommunitySuiteCatalogView, CommunitySuiteInstallPreview, CommunitySuiteInstallView, CommunitySuiteUninstallPreview } from '../domain/admin-contract.js'
import { suiteInstallInput, suiteRuntimeDependencyDefinition, type SuiteCatalogArchitecture, type SuiteCatalogItem, type SuiteCatalogItemKind, type SuiteCatalogRuntimeDependencyItem, type SuiteCatalogSkillItem, type SuiteCatalogSkillPackItem, type SuiteCatalogExecutionItem, type SuiteCatalogEntry, type SuiteInstallRequest, invalidRequest, suiteCredentialsInput, suiteUninstallInput } from '../domain/suite-catalog.js'
import { suiteExecutionOwner, suiteInstallOrigin, type SuiteInstalledEntry, type SuiteInstallRecord, type SuiteInstallState } from '../domain/suite-install.js'
import { RuntimeDependencyPreparationFailure, type RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { SkillGitTarget } from '../domain/skill-git-source.js'
import type { SuiteExecutionTemplate } from '../domain/platform-execution.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { Clock } from '../ports/clock.js'
import type { SuiteInstallStorePort } from '../ports/suite-catalog.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'

interface SuiteItemPlan { readonly name: string, readonly commands?: readonly string[], readonly detail?: string }
/** What a commit may read from earlier commits in the same task. */
interface SuiteCommitContext {
  /** Wizard-only inputs such as credentials; they are never stored in the install record. */
  readonly request: SuiteInstallRequest
  /** Library name a suite runtime-dependency item committed under (a collision may add a suffix). */
  dependencyName(item: string): string
  /** Library names of shared catalog dependencies, installed in this task or reused. */
  catalogDependencyNames(ids: readonly string[]): readonly string[]
}

/** Each entry kind implements plan, prepare, commit, rollback and uninstall with the same shape. */
interface SuiteItemOperations<Item extends SuiteCatalogItem, Prepared> {
  available(item: Item): boolean
  plan(item: Item): SuiteItemPlan
  prepare(item: Item, plan: SuiteItemPlan, origin: string, log: (line: string) => Promise<void>): Promise<Prepared>
  commit(item: Item, plan: SuiteItemPlan, prepared: Prepared, origin: string, context: SuiteCommitContext): Promise<readonly SuiteInstalledEntry[]>
  rollback(origin: string): Promise<void>
  uninstall(entry: SuiteInstalledEntry, origin: string): Promise<void>
  /** Turns one owned entry into an ordinary library entry; grants, publication and references stay as they are. */
  detach(entry: SuiteInstalledEntry, origin: string): Promise<void>
  references(entry: SuiteInstalledEntry): readonly { kind: string, name: string }[]
}

class RuntimeDependencySuiteKind implements SuiteItemOperations<SuiteCatalogRuntimeDependencyItem, RuntimeDependencyVersion> {
  constructor(private readonly dependencies: RuntimeDependencies, private readonly architecture: () => SuiteCatalogArchitecture, private readonly signal: () => AbortSignal) {}
  available(item: SuiteCatalogRuntimeDependencyItem): boolean { return Boolean(suiteRuntimeDependencyDefinition(item, this.architecture())) }
  plan(item: SuiteCatalogRuntimeDependencyItem): SuiteItemPlan & { definition: CommunityRuntimeDependencyInput } {
    const definition = suiteRuntimeDependencyDefinition(item, this.architecture())
    if (!definition) throw new BusinessRuleError('invalid', 'This suite entry has no preparation for the current architecture.', 'suite-arch-unavailable')
    return { name: definition.name, commands: item.commands, definition }
  }
  async prepare(_item: SuiteCatalogRuntimeDependencyItem, plan: SuiteItemPlan & { definition: CommunityRuntimeDependencyInput }, _origin: string, log: (line: string) => Promise<void>): Promise<RuntimeDependencyVersion> {
    await log(`Preparing runtime dependency ${plan.name}…`)
    try { return await this.dependencies.stageManaged(plan.definition, async () => {}, this.signal()) }
    catch (error) {
      if (error instanceof RuntimeDependencyPreparationFailure) await log(error.log.trimEnd())
      throw error
    }
  }
  async commit(_item: SuiteCatalogRuntimeDependencyItem, plan: SuiteItemPlan & { definition: CommunityRuntimeDependencyInput }, version: RuntimeDependencyVersion, origin: string): Promise<readonly SuiteInstalledEntry[]> {
    return [{ kind: 'runtime-dependency', name: this.dependencies.commitManaged(origin, plan.definition, version) }]
  }
  rollback(): Promise<void> { return this.dependencies.collectUnretained() }
  uninstall(entry: SuiteInstalledEntry, origin: string): Promise<void> { void entry; return this.dependencies.removeManaged(origin) }
  detach(entry: SuiteInstalledEntry, origin: string): Promise<void> { this.dependencies.detachManaged(origin, entry.name); return Promise.resolve() }
  references(entry: SuiteInstalledEntry) { return this.dependencies.dependencyReferences(entry.name).map(reference => ({ kind: reference.kind, name: reference.name })) }
}

class SkillSuiteKind implements SuiteItemOperations<SuiteCatalogSkillItem, null> {
  constructor(private readonly skills: SkillSuitePort, private readonly signal: () => AbortSignal, private readonly packs: SkillPackSuitePort) {}
  available(): boolean { return true }
  plan(item: SuiteCatalogSkillItem): SuiteItemPlan {
    const source = item.source
    return { name: `${item.names.length} skills`, detail: `${source.url.replace('https://github.com/', '')} @ ${source.commit.slice(0, 7)}` }
  }
  async prepare(item: SuiteCatalogSkillItem, _plan: SuiteItemPlan, origin: string, log: (line: string) => Promise<void>): Promise<null> {
    const source = item.source
    const target: SkillGitTarget = { url: source.url, subpath: source.path, ref: source.commit }
    await log(`Importing skills from ${source.url} @ ${source.commit.slice(0, 7)}…`)
    await this.skills.prepareSuiteImport(origin, target, item.names, log, this.signal())
    return null
  }
  async commit(item: SuiteCatalogSkillItem, _plan: SuiteItemPlan, _prepared: null, origin: string, context: SuiteCommitContext): Promise<readonly SuiteInstalledEntry[]> {
    const names = [...item.runtimeDependency !== undefined ? [context.dependencyName(item.runtimeDependency)] : [], ...context.catalogDependencyNames(item.catalogDependencies ?? [])]
    const rows = await this.skills.commitSuiteSkills(origin, names)
    return rows.map(row => ({ kind: 'skill' as const, name: row.name }))
  }
  rollback(origin: string): Promise<void> { return this.skills.discardSuiteImport(origin) }
  uninstall(entry: SuiteInstalledEntry, origin: string): Promise<void> { void entry; return this.skills.removeSuiteSkills(origin) }
  detach(entry: SuiteInstalledEntry, origin: string): Promise<void> { return this.skills.detachSuiteSkill(origin, entry.name) }
  references(entry: SuiteInstalledEntry) { return this.packs.manualPacksContaining(entry.name).map(name => ({ kind: 'skill-pack', name })) }
}

class SkillPackSuiteKind implements SuiteItemOperations<SuiteCatalogSkillPackItem, null> {
  constructor(private readonly packs: SkillPackSuitePort) {}
  available(): boolean { return true }
  plan(item: SuiteCatalogSkillPackItem): SuiteItemPlan { return { name: item.name, detail: `${item.skills.length} skills` } }
  async prepare(): Promise<null> { return null }
  async commit(item: SuiteCatalogSkillPackItem, _plan: SuiteItemPlan, _prepared: null, origin: string): Promise<readonly SuiteInstalledEntry[]> {
    await this.packs.commitSuitePack(origin, { name: item.name, description: item.description, skills: item.skills, instructions: item.note })
    return [{ kind: 'skill-pack', name: item.name }]
  }
  rollback(): Promise<void> { return Promise.resolve() }
  uninstall(entry: SuiteInstalledEntry, origin: string): Promise<void> { void entry; return this.packs.removeSuitePack(origin) }
  detach(entry: SuiteInstalledEntry, origin: string): Promise<void> { return this.packs.detachSuitePack(origin, entry.name) }
  references(): readonly { kind: string, name: string }[] { return [] }
}

/** Delegated execution belongs to a suite skill; variable values arrive only with the install request or a later credential save. */
class ExecutionSuiteKind implements SuiteItemOperations<SuiteCatalogExecutionItem, null> {
  constructor(private readonly execution: ExecutionSuitePort | undefined) {}
  available(): boolean { return this.execution !== undefined }
  /** The plan lists delegated command names; the detail lists the credential variables. */
  plan(item: SuiteCatalogExecutionItem): SuiteItemPlan { return { name: item.delegated.map(row => row.command).join(', '), detail: item.variables.map(row => row.name).join(', ') } }
  async prepare(): Promise<null> { return null }
  async commit(item: SuiteCatalogExecutionItem, _plan: SuiteItemPlan, _prepared: null, origin: string, context: SuiteCommitContext): Promise<readonly SuiteInstalledEntry[]> {
    await this.require().commitSuiteExecution(origin, suiteExecutionOwner(item.skill), { commands: item.delegated, variables: item.variables.map(row => row.name), runtimeDependencies: [context.dependencyName(item.runtimeDependency)] },
      credentialsFor(item, context.request.credentials ?? {}))
    return [{ kind: 'execution', name: item.skill }]
  }
  rollback(origin: string): Promise<void> { return this.execution?.removeSuiteExecution(origin) ?? Promise.resolve() }
  uninstall(_entry: SuiteInstalledEntry, origin: string): Promise<void> { return this.rollback(origin) }
  detach(entry: SuiteInstalledEntry, origin: string): Promise<void> { return this.require().detachSuiteExecution(origin, suiteExecutionOwner(entry.name)) }
  references(): readonly { kind: string, name: string }[] { return [] }
  private require(): ExecutionSuitePort {
    if (!this.execution) throw new BusinessRuleError('invalid', 'Unsupported suite entry kind.', 'suite-catalog-invalid')
    return this.execution
  }
}

/** Narrow ports so tests can drive the use case with in-memory doubles. */
export interface SkillSuitePort {
  prepareSuiteImport(origin: string, source: SkillGitTarget, names: readonly string[], log: (line: string) => Promise<void>, signal: AbortSignal): Promise<void>
  suiteSkillConflicts(origin: string, names: readonly string[]): readonly string[]
  commitSuiteSkills(origin: string, runtimeDependencies?: readonly string[]): Promise<readonly { name: string }[]>
  discardSuiteImport(origin: string): Promise<void>
  removeSuiteSkills(origin: string): Promise<void>
  detachSuiteSkill(origin: string, name: string): Promise<void>
}
export interface SkillPackSuitePort {
  commitSuitePack(origin: string, input: { name: string, description: string, skills: readonly string[], instructions: string }): Promise<void>
  removeSuitePack(origin: string): Promise<void>
  detachSuitePack(origin: string, name: string): Promise<void>
  applySuiteOptions(name: string, options: { readonly publish?: boolean, readonly groups?: readonly string[] }): Promise<void>
  suiteImpact(name: string): { groups: readonly { id: string, name: string }[], published: boolean, selectedMembers: number } | undefined
  manualPacksContaining(name: string): readonly string[]
}
export interface ExecutionSuitePort {
  commitSuiteExecution(origin: string, owner: string, template: SuiteExecutionTemplate, credentials: Readonly<Record<string, string>>): Promise<void>
  saveSuiteCredentials(origin: string, owner: string, credentials: Readonly<Record<string, string>>): Promise<void>
  removeSuiteExecution(origin: string): Promise<void>
  detachSuiteExecution(origin: string, owner: string): Promise<void>
  suiteMissingCredentials(owner: string): readonly string[]
  delegatedCommandConflicts(owner: string, commands: readonly string[]): readonly string[]
}

/** Keeps only the values this execution item declares. */
function credentialsFor(item: SuiteCatalogExecutionItem, credentials: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  const names = new Set(item.variables.map(row => row.name))
  return Object.fromEntries(Object.entries(credentials).filter(([name]) => names.has(name)))
}

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
  constructor(private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>, private readonly presets: readonly SuiteCatalogEntry[], private readonly store: SuiteInstallStorePort,
    private readonly dependencies: RuntimeDependencies, private readonly clock: Clock, architecture: SuiteCatalogArchitecture,
    private readonly skills: SkillSuitePort, private readonly packs: SkillPackSuitePort, private readonly execution?: ExecutionSuitePort) {
    this.runtimeDependencyKind = new RuntimeDependencySuiteKind(dependencies, () => architecture, () => this.shutdown.signal)
    this.skillKind = new SkillSuiteKind(skills, () => this.shutdown.signal, packs)
    this.skillPackKind = new SkillPackSuiteKind(packs)
    this.executionKind = new ExecutionSuiteKind(execution)
  }
  catalog(actor: CommunityAccountActor): CommunitySuiteCatalogView {
    this.assertAdmin(actor)
    const state = this.store.read()
    return {
      entries: this.presets.map(entry => {
        const record = state.installs.find(row => row.id === entry.id)
        const suite = entry.category === 'suite' ? entry : undefined
        const packName = suite?.items.find(item => item.kind === 'skill-pack')?.name
        return { id: entry.id, category: entry.category, title: entry.title, description: entry.description, source: entry.source, version: entry.version,
          commands: [...new Set(entry.items.flatMap(item => item.kind === 'runtime-dependency' ? item.commands : []))], available: this.available(entry),
          ...(suite ? { identity: suite.identity, skills: suite.items.flatMap(item => item.kind === 'skill' ? item.names : []) } : {}),
          ...(packName !== undefined ? { packName } : {}),
          ...(suite?.dependencies.length ? { dependencies: suite.dependencies } : {}),
          ...(this.executionItems(entry).length ? { execution: { commands: this.executionItems(entry).flatMap(item => item.delegated), variables: this.executionItems(entry).flatMap(item => item.variables) } } : {}),
          ...(record ? { installedVersion: record.version, ...(record.status === 'installed' && record.version !== entry.version ? { updateAvailable: true } : {}) } : {}) }
      }),
      installations: state.installs.map(row => this.view(row)),
    }
  }
  installPreview(actor: CommunityAccountActor, id: string): CommunitySuiteInstallPreview {
    this.assertAdmin(actor)
    const entry = this.require(id), record = this.store.read().installs.find(row => row.id === id)
    const available = this.available(entry)
    const conflicts = this.skills.suiteSkillConflicts(suiteInstallOrigin(id), entry.items.flatMap(item => item.kind === 'skill' ? item.names : []))
    const commandConflicts = this.commandConflicts(entry)
    const shared = this.sharedDependencies(entry)
    const reason = record?.status === 'installed' ? 'already-installed' : record && record.status !== 'failed' || shared.busy ? 'task-running' : !available ? 'unavailable-architecture' : conflicts.length ? 'skill-conflicts' : commandConflicts.length ? 'command-conflicts' : undefined
    const creates = reason === undefined ? entry.items.map(item => { const plan = this.operationsFor(item.kind).plan(item)
      return { kind: item.kind, name: plan.name, ...(plan.commands ? { commands: plan.commands } : {}), ...(plan.detail ? { detail: plan.detail } : {}) } }) : []
    const dependencies = [...shared.install.map(row => ({ id: row.entry.id, action: 'install' as const })), ...shared.reuse.map(id => ({ id, action: 'reuse' as const }))]
    return { id, version: entry.version, available, ...(reason ? { reason } : {}), creates, ...(conflicts.length ? { conflicts } : {}), ...(commandConflicts.length ? { commandConflicts } : {}), ...(dependencies.length ? { dependencies } : {}) }
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
    if (previous && previous.status !== 'failed') throw new BusinessRuleError('conflict',
      previous.status === 'installed' ? 'This catalog entry is already installed.' : 'A task is already running for this entry.',
      previous.status === 'installed' ? 'suite-already-installed' : 'suite-task-running')
    if (!this.available(entry)) throw new BusinessRuleError('invalid', 'This suite entry has no preparation for the current architecture.', 'suite-arch-unavailable')
    const variables = new Set(this.executionItems(entry).flatMap(item => item.variables.map(row => row.name)))
    if (Object.keys(value.credentials ?? {}).some(name => !variables.has(name))) throw invalidRequest()
    if (this.commandConflicts(entry).length) throw new BusinessRuleError('conflict', 'A command name is already delegated by another owner.', 'execution-config-invalid')
    if (this.skills.suiteSkillConflicts(suiteInstallOrigin(value.id), entry.items.flatMap(item => item.kind === 'skill' ? item.names : [])).length) throw new BusinessRuleError('conflict', 'A skill with this name already exists with a different origin.', 'suite-skill-conflict')
    const shared = this.sharedDependencies(entry)
    if (shared.busy) throw new BusinessRuleError('conflict', 'A task is already running for this entry.', 'suite-task-running')
    // Declaring dependencies on the record up front makes an in-flight install count as their user.
    const record: SuiteInstallRecord = { id: entry.id, version: entry.version, status: 'installing', entries: [], requestId: value.requestId, updatedAt: this.clock.now(),
      ...(entry.category === 'suite' && entry.dependencies.length ? { dependencies: entry.dependencies } : {}),
      log: `${previous?.log ? previous.log + '\n---\n' : ''}Installing ${entry.id} ${entry.version}…` }
    // Missing shared dependencies join this task; their own records stay busy until it ends.
    const dependencyRecords = shared.install.map(({ entry: dependency, previous: old }): SuiteInstallRecord => ({ id: dependency.id, version: dependency.version, status: 'installing', entries: [], updatedAt: this.clock.now(),
      log: `${old?.log ? old.log + '\n---\n' : ''}Installing ${dependency.id} ${dependency.version} for ${entry.id}…` }))
    const replaced = new Set([entry.id, ...dependencyRecords.map(row => row.id)])
    this.write(next => ({ ...next, requests: [...next.requests ?? [], value.requestId].slice(-200), installs: [...next.installs.filter(item => !replaced.has(item.id)), ...dependencyRecords, record] }))
    this.startInstall(entry, value, shared.install)
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
      this.saveRecord(id, row => ({ ...row, status: 'installed', entries: row.entries.filter(next => !entries.some(gone => gone.kind === next.kind && gone.name === next.name)), updatedAt: this.clock.now(),
        log: row.log + entries.map(next => `\nDetached ${next.kind} ${next.name}.`).join('') }))
    }
  }
  /** Interrupted tasks carry no in-memory job after a restart; committed rows are rolled back here. */
  async recover(): Promise<void> {
    // Suites first: their skills reference shared dependencies, which can only be removed afterwards.
    const order = (row: SuiteInstallRecord) => this.presets.find(entry => entry.id === row.id)?.category === 'dependency' ? 1 : 0
    for (const row of [...this.store.read().installs].sort((a, b) => order(a) - order(b))) {
      if (this.jobs.has(row.id)) continue
      if (row.status === 'installing') {
        await this.cleanup(row.id).catch(() => {})
        await this.skills.discardSuiteImport(row.id).catch(() => {})
        this.saveRecord(row.id, record => ({ ...record, status: 'failed', failureCode: 'interrupted', updatedAt: this.clock.now(), log: record.log + '\nInstallation was interrupted. Retry to install again.' }))
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
  async stop(): Promise<void> {
    this.shutdown.abort()
    await Promise.allSettled([...this.jobs.values()])
  }
  private startInstall(entry: SuiteCatalogEntry, options: SuiteInstallRequest, dependencies: readonly DependencyInstall[]): void {
    if (this.jobs.has(entry.id)) return
    const job = this.runInstall(entry, options, dependencies).finally(() => this.jobs.delete(entry.id))
    this.jobs.set(entry.id, job); void job.catch(() => {})
  }
  private async runInstall(entry: SuiteCatalogEntry, options: SuiteInstallRequest, dependencies: readonly DependencyInstall[]): Promise<void> {
    const prepared: PreparedJob[] = []
    const log = (line: string) => this.appendLog(entry.id, line)
    // Shared dependencies prepare and commit first, under their own catalog origin, so suite skills can reference them.
    const units = [...dependencies.map(row => row.entry), entry]
    const names = new Map<string, string>(), installed = new Map<string, SuiteInstalledEntry[]>()
    try {
      for (const unit of units) for (const item of unit.items) {
        const operations = this.operationsFor(item.kind)
        const plan = operations.plan(item)
        prepared.push({ operations, item, plan, unit: unit.id, value: await operations.prepare(item, plan, suiteInstallOrigin(unit.id), log) })
        await log(`${plan.name} prepared.`)
      }
      await log('Writing library entries…')
      for (const job of prepared) {
        const context: SuiteCommitContext = { request: options, dependencyName: item => names.get(committedKey(job.unit, item)) ?? item,
          catalogDependencyNames: ids => ids.map(id => this.catalogDependencyName(id, names)) }
        const entries = await job.operations.commit(job.item, job.plan, job.value, suiteInstallOrigin(job.unit), context)
        if (job.item.kind === 'runtime-dependency' && entries[0]) names.set(committedKey(job.unit, job.item.name), entries[0].name)
        installed.set(job.unit, [...installed.get(job.unit) ?? [], ...entries])
        this.saveRecord(job.unit, row => ({ ...row, entries: [...row.entries, ...entries.filter(next => !row.entries.some(previous => previous.kind === next.kind && previous.name === next.name))] }))
      }
      for (const unit of units) this.saveRecord(unit.id, row => {
        const { failureCode, ...record } = row; void failureCode
        return { ...record, status: 'installed', version: unit.version, entries: installed.get(unit.id) ?? [], updatedAt: this.clock.now(),
          ...(unit.id !== entry.id ? { log: record.log + `\nInstalled with ${entry.id}.` } : {}) }
      })
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
      for (const job of [...prepared].reverse()) await job.operations.rollback(suiteInstallOrigin(job.unit)).catch(() => {})
      // A failure after the first commit leaves owned rows behind; remove every origin of this task again, suite first.
      for (const unit of [...units].reverse()) await this.cleanup(unit.id).catch(() => {})
      const failure = error instanceof RuntimeDependencyPreparationFailure || error instanceof BusinessRuleError ? error.code : 'prepare-failed'
      for (const dependency of dependencies) this.restoreDependencyRecord(dependency, `Install with ${entry.id} failed; nothing was kept.`)
      this.saveRecord(entry.id, row => ({ ...row, status: 'failed', failureCode: failure, entries: [], updatedAt: this.clock.now(),
        log: row.log + '\n' + (error instanceof Error && !(error instanceof BusinessRuleError) ? error.message : 'Installation failed. Nothing was written.') }))
    }
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
    return entry.items.every(item => this.operationsFor(item.kind).available(item))
      && (entry.category !== 'suite' || this.sharedDependencies(entry).install.every(row => this.available(row.entry)))
  }
  /** Splits a suite's catalog dependencies into ones to install in its task and ones already in the library. */
  private sharedDependencies(entry: SuiteCatalogEntry): { readonly install: readonly DependencyInstall[], readonly reuse: readonly string[], readonly busy: boolean } {
    if (entry.category !== 'suite') return { install: [], reuse: [], busy: false }
    const installs = this.store.read().installs, install: DependencyInstall[] = [], reuse: string[] = []
    let busy = false
    for (const id of entry.dependencies) {
      const record = installs.find(row => row.id === id)
      if (record?.status === 'installed') reuse.push(id)
      else if (record && record.status !== 'failed') busy = true
      else install.push({ entry: this.require(id), ...(record ? { previous: record } : {}) })
    }
    return { install, reuse, busy }
  }
  /** Library name of a shared catalog dependency, whether this task or an earlier install committed it. */
  private catalogDependencyName(id: string, committed: ReadonlyMap<string, string>): string {
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
    return this.executionItems(entry).flatMap(item => this.execution?.delegatedCommandConflicts(suiteExecutionOwner(item.skill), item.delegated.map(row => row.command)) ?? [])
  }
  private executionItems(entry: SuiteCatalogEntry): readonly SuiteCatalogExecutionItem[] { return entry.items.filter((item): item is SuiteCatalogExecutionItem => item.kind === 'execution') }
  private require(id: string): SuiteCatalogEntry {
    const entry = this.presets.find(row => row.id === id)
    if (!entry) throw new BusinessRuleError('missing', 'This catalog entry does not exist.', 'suite-not-found')
    return entry
  }
  private requireInstalled(id: string): SuiteInstallRecord {
    const record = this.store.read().installs.find(row => row.id === id)
    if (!record || record.status !== 'installed' && record.status !== 'failed') throw new BusinessRuleError(record ? 'conflict' : 'missing',
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
    return { id: row.id, version: row.version, status: row.status, entries: row.entries, updatedAt: row.updatedAt, log: row.log, ...(missing.length ? { missingCredentials: missing } : {}), ...(row.dependencies?.length ? { dependencies: row.dependencies } : {}) }
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const account = this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch) throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required.', 'admin-required')
  }
}
