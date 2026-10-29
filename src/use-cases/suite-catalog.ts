import { SuiteCatalogQueries } from './suite-catalog-queries.js'
import { SuiteChanges } from './suite-changes.js'
import { SuiteTransactions } from './suite-transactions.js'
import { SuiteRetirement } from './suite-retirement.js'
import { SuiteTaskRecords } from './suite-task-records.js'
import { KeyedOperations } from './support/keyed-operations.js'
import { BusinessRuleError } from '../domain/business-error.js'
import { CommunityAuthenticationError, type CommunityAccountActor } from '../domain/community-account.js'
import type {
  CommunitySuiteCatalogView,
  CommunitySuiteInstallPreview,
  CommunitySuiteInstallView,
  CommunitySuiteUninstallPreview,
  CommunitySuiteUpdatePreview,
} from '../domain/admin-contract.js'
import {
  suiteCatalogRefusal,
  suiteInstallInput,
  suiteCredentialsInput,
  suiteUninstallInput,
  invalidRequest,
  type SuiteCatalogArchitecture,
  type SuiteCatalogEntry,
  type SuiteCatalogPluginItem,
  type SuiteInstallRequest,
  type SuiteReplacedEntry,
} from '../domain/suite-catalog.js'
import { suiteExecutionOwner, suiteInstallOrigin } from '../domain/suite-install.js'
import type { CatalogInstallRecord } from '../domain/catalog-install.js'
import type { CatalogInstallRows, CatalogRequestRows, CatalogInstallRow, CatalogRequestRow } from '../ports/catalog-records.js'
import type { SuiteUnitOfWork } from '../ports/suite-unit-of-work.js'
import type { PluginAccessSyntaxPort } from '../ports/plugin-access.js'
import type { ExpertReferencesPort } from '../ports/experts.js'
import type { CommunityAccountReaderPort } from '../ports/community-accounts.js'
import type { Clock } from '../ports/clock.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import type { SkillLibrary } from './skill-library.js'
import type { SuitePlugins } from './suite-plugins.js'
import {
  suitePreparationFailure,
  credentialsFor,
  type SkillSuitePort,
  type SkillSuiteUpdatePort,
  type SkillPackSuitePort,
  type SkillPackSuiteUpdatePort,
  type ExecutionSuitePort,
  type ExecutionSuiteUpdatePort,
  type PluginSuitePort,
  type PluginSuiteUpdatePort,
  type SuiteReplacementPlan,
} from './suite-entry-kinds.js'
import { replacementBusy, replacementConfirmed, replacementEntries, type SuiteReplacements } from './suite-replacements.js'
import type { SuiteCatalogGallery } from './suite-catalog-gallery.js'
export type { ExecutionSuitePort, PluginSuitePort, SkillPackSuitePort, SkillSuitePort } from './suite-entry-kinds.js'
export interface SuiteCatalogStorage {
  readonly expertReferences: ExpertReferencesPort
  readonly installs: CatalogInstallRows
  readonly requests: CatalogRequestRows
  readonly work: SuiteUnitOfWork
}
type CatalogSkills = SkillSuitePort &
  SkillSuiteUpdatePort &
  Pick<SkillLibrary, 'preparedSuiteImport' | 'withSuiteNotes'> &
  Partial<Pick<SkillLibrary, 'synchronizeContribution'>>
type CatalogPlugins = PluginSuitePort & PluginSuiteUpdatePort & Pick<SuitePlugins, 'prepareCatalogPlugin'>

/** Owns admission, jobs and shutdown; every capability change is a prepared database transaction. */
export class SuiteCatalog {
  private readonly operations = new KeyedOperations()
  private readonly jobs = new Map<string, Promise<void>>()
  private readonly active = new Set<Promise<void>>()
  private readonly claims = new Map<string, { packageName: string; origin: string }>()
  private readonly replacementClaims = new Map<string, readonly SuiteReplacedEntry[]>()
  private readonly shutdown = new AbortController()
  private readonly queries: SuiteCatalogQueries
  private readonly changes: SuiteChanges
  private readonly retirement: SuiteRetirement
  private readonly tasks: SuiteTaskRecords
  constructor(
    private readonly accounts: Pick<CommunityAccountReaderPort, 'get'>,
    private readonly gallery: Pick<SuiteCatalogGallery, 'entries' | 'source' | 'load'>,
    private readonly storage: SuiteCatalogStorage,
    private readonly dependencies: RuntimeDependencies,
    private readonly clock: Clock,
    architecture: SuiteCatalogArchitecture,
    private readonly skills: CatalogSkills,
    private readonly packs: SkillPackSuitePort & SkillPackSuiteUpdatePort,
    private readonly execution?: ExecutionSuitePort & ExecutionSuiteUpdatePort,
    private readonly plugins?: CatalogPlugins,
    private readonly policy: { readonly syntax?: PluginAccessSyntaxPort; readonly compatibilityTarget?: string; readonly changed?: () => Promise<void> } = {},
  ) {
    this.queries = new SuiteCatalogQueries(
      gallery,
      storage.installs,
      storage.expertReferences,
      dependencies,
      architecture,
      skills,
      packs,
      execution,
      plugins,
      () => [...this.replacementClaims.values()].flat(),
    )
    this.changes = new SuiteChanges(
      new SuiteTransactions(storage.work, dependencies, clock, policy.syntax, policy.compatibilityTarget),
      dependencies,
      skills,
      architecture,
      () => this.shutdown.signal,
      plugins,
    )
    this.retirement = new SuiteRetirement(storage.work, dependencies, clock)
    this.tasks = new SuiteTaskRecords(storage.work, clock)
    plugins?.observeSuiteClaims?.(() => [...this.claims.values()])
  }
  async catalog(actor: CommunityAccountActor): Promise<CommunitySuiteCatalogView> {
    await this.assertAdmin(actor)
    return this.queries.catalog()
  }
  async refreshCatalog(actor: CommunityAccountActor): Promise<void> {
    await this.assertAdmin(actor)
    await this.gallery.load()
  }
  async installPreview(actor: CommunityAccountActor, id: string): Promise<CommunitySuiteInstallPreview> {
    await this.assertAdmin(actor)
    return this.queries.installPreview(id)
  }
  async uninstallPreview(actor: CommunityAccountActor, id: string): Promise<CommunitySuiteUninstallPreview> {
    await this.assertAdmin(actor)
    return this.queries.uninstallPreview(id)
  }
  async updatePreview(actor: CommunityAccountActor, id: string): Promise<CommunitySuiteUpdatePreview> {
    await this.assertAdmin(actor)
    return this.queries.updatePreview(id)
  }
  async install(actor: CommunityAccountActor, input: unknown): Promise<CommunitySuiteInstallView> {
    const acceptedActor = structuredClone(actor),
      acceptedInput = structuredClone(input)
    this.assertOpen()
    return await this.operations.run('catalog', async () => {
      this.assertOpen()
      await this.assertAdmin(acceptedActor)
      const value = suiteInstallInput(acceptedInput)
      const receipt = await this.storage.requests.get(value.requestId)
      if (receipt) {
        const existing = await this.storage.installs.get(receipt.result.id)
        if (receipt.result.status !== 'retired' && existing?.record.requestId === value.requestId) return this.queries.view(existing.record)
        throw new BusinessRuleError('conflict', 'This install request was already retired. Start a new install.', 'suite-request-retired')
      }
      const entry = this.queries.require(value.id),
        state = await this.queries.state()
      const previous = state.installs.find(row => row.id === value.id)
      if (previous && previous.status !== 'failed')
        throw new BusinessRuleError(
          'conflict',
          previous.status === 'installed' ? 'This catalog entry is already installed.' : 'A task is already running for this entry.',
          previous.status === 'installed' ? 'suite-already-installed' : 'suite-task-running',
        )
      if (entry.unavailableReason) throw suiteCatalogRefusal(entry.unavailableReason)
      const shared = await this.queries.availability.plan(entry)
      if (!(await this.queries.availability.available(entry, shared)))
        throw new BusinessRuleError('invalid', 'This suite entry has no preparation for the current architecture.', 'suite-arch-unavailable')
      const variables = new Set(this.queries.executionItems(entry).flatMap(item => item.variables.map(row => row.name)))
      if (Object.keys(value.credentials ?? {}).some(name => !variables.has(name))) throw invalidRequest()
      for (const item of entry.items) if (item.kind === 'plugin') await this.plugins?.assertSuiteAdmission(suiteInstallOrigin(entry.id), item.packageName)
      const plan = await this.queries.replacements(entry)
      if (shared.missing.length) throw new BusinessRuleError('missing', 'A shared catalog dependency is not available right now.', 'suite-dependency-missing')
      if (plan.conflicts.length || shared.conflicts.length)
        throw new BusinessRuleError(
          'conflict',
          plan.plugins.length && plan.conflicts.some(name => plan.plugins.some(row => row.row.packageName === name))
            ? 'This plugin package is already in the library.'
            : 'Other dependencies already provide these commands.',
          plan.plugins.length && plan.conflicts.some(name => plan.plugins.some(row => row.row.packageName === name))
            ? 'plugin-name-in-use'
            : 'suite-dependency-conflict',
        )
      if ((await this.queries.packConflicts(entry)).length)
        throw new BusinessRuleError('invalid', 'Review the skill pack name and selected skills.', 'skill-pack-invalid')
      if ((await this.queries.commandConflicts(entry)).length)
        throw new BusinessRuleError('conflict', 'A command name is already delegated by another owner.', 'execution-config-invalid')
      if (
        (
          await this.skills.suiteSkillConflicts(
            suiteInstallOrigin(value.id),
            entry.items.flatMap(item => (item.kind === 'skill' ? item.names : [])),
          )
        ).some(name => !plan.skills.some(row => row.name === name))
      )
        throw new BusinessRuleError('conflict', 'A skill with this name already exists with a different origin.', 'suite-skill-conflict')
      if (shared.busy || replacementBusy(plan, [...this.replacementClaims.values()].flat()))
        throw new BusinessRuleError('conflict', 'A task is already running for this entry.', 'suite-task-running')
      if (!replacementConfirmed(plan, value.replace))
        throw new BusinessRuleError('conflict', 'Confirm replacing the manual entries listed in the preview.', 'suite-replace-unconfirmed')
      // Declaring dependencies on the record up front makes an in-flight install count as their user.
      const pluginPackage =
        entry.category === 'plugin' ? entry.items.find((item): item is SuiteCatalogPluginItem => item.kind === 'plugin')?.packageName : undefined
      const record: CatalogInstallRecord = {
        id: entry.id,
        version: entry.version,
        status: 'installing',
        category: entry.category,
        ...(entry.contentHash ? { contentHash: entry.contentHash } : {}),
        ...(pluginPackage !== undefined ? { pluginPackage } : {}),
        entries: [],
        requestId: value.requestId,
        updatedAt: this.clock.now(),
        ...(entry.category !== 'dependency' && entry.dependencies.length ? { dependencies: entry.dependencies } : {}),
        ...(shared.manual.length ? { manualDependencies: shared.manual } : {}),

        log: `${previous?.log ? previous.log + '\n---\n' : ''}Installing ${entry.id} ${entry.version}…`,
      }
      // Missing shared dependencies join this task; their own records stay busy until it ends.
      const dependencyRecords = shared.install.map(({ entry: dependency, previous: old }): CatalogInstallRecord => ({
        id: dependency.id,
        version: dependency.version,
        category: dependency.category,
        ...(dependency.contentHash ? { contentHash: dependency.contentHash } : {}),
        status: 'installing',
        entries: [],
        updatedAt: this.clock.now(),
        log: `${old?.log ? old.log + '\n---\n' : ''}Installing ${dependency.id} ${dependency.version} for ${entry.id}…`,
      }))
      const previousRows = (await this.storage.installs.list()).filter(row => dependencyRecords.some(next => next.id === row.record.id))
      this.assertOpen()
      const admitted = await this.tasks.admit(acceptedActor, [...dependencyRecords, record], value)
      this.claim(record)
      this.replacementClaims.set(entry.id, replacementEntries(plan))
      this.start(entry.id, () =>
        this.runInstall(acceptedActor, [...shared.install.map(row => row.entry), entry], value, plan, admitted.installs, admitted.request, previousRows),
      )
      return this.queries.view(record)
    })
  }
  async saveCredentials(actor: CommunityAccountActor, id: string, input: unknown): Promise<void> {
    const accepted = structuredClone({ actor, input })
    this.assertOpen()
    return this.operations.run('catalog', async () => {
      this.assertOpen()
      await this.assertAdmin(accepted.actor)
      const record = (await this.queries.installed(id)).record,
        entry = this.queries.require(id),
        credentials = suiteCredentialsInput(accepted.input)
      const items = this.queries.executionItems(entry).filter(item => record.entries.some(row => row.kind === 'execution' && row.name === item.skill))
      if (!items.length || !this.execution || Object.keys(credentials).some(name => !items.some(item => item.variables.some(row => row.name === name))))
        throw invalidRequest()
      for (const item of items)
        await this.execution.saveSuiteCredentials(suiteInstallOrigin(id), suiteExecutionOwner(item.skill), credentialsFor(item, credentials))
    })
  }
  async update(actor: CommunityAccountActor, id: string): Promise<CommunitySuiteInstallView> {
    const accepted = structuredClone(actor)
    this.assertOpen()
    return this.operations.run('catalog', async () => {
      this.assertOpen()
      await this.assertAdmin(accepted)
      const installed = await this.queries.installed(id),
        entry = this.queries.require(id)
      if (entry.unavailableReason) throw suiteCatalogRefusal(entry.unavailableReason)
      const preview = await this.queries.updatePreview(id)
      if (preview.reason)
        throw new BusinessRuleError(
          'conflict',
          'This entry cannot be updated now.',
          preview.reason === 'up-to-date'
            ? 'suite-up-to-date'
            : preview.reason === 'dependency-missing'
              ? 'suite-dependency-missing'
              : preview.reason === 'skill-conflicts'
                ? 'suite-skill-conflict'
                : 'suite-arch-unavailable',
        )
      this.assertOpen()
      const task = await this.begin(accepted, installed, 'updating', `Updating ${id} ${installed.record.version} → ${entry.version}…`)
      this.claim(task.record)
      this.start(id, async () => {
        const lines: string[] = []
        try {
          await this.changes.update(accepted, task, entry, async line => {
            lines.push(line)
          })
        } catch (error) {
          // COMMIT may have succeeded before a view publisher failed. Only the unchanged pending task may be reset.
          await this.failTask(task, suitePreparationFailure(error), 'Update failed; the previous version is still in use.\n' + lines.join('\n'))
        }
        await this.synchronize()
      })
      return this.queries.view(task.record)
    })
  }
  async uninstall(actor: CommunityAccountActor, id: string, input?: unknown): Promise<void> {
    const accepted = structuredClone(actor),
      request = suiteUninstallInput(input)
    this.assertOpen()
    await this.operations.run('catalog', async () => {
      this.assertOpen()
      await this.assertAdmin(accepted)
      const installed = await this.queries.installed(id),
        record = installed.record
      const preview = await this.queries.uninstallPreview(id)
      if ((preview.experts.length || request.expertRevision !== undefined) && request.expertRevision !== preview.expertRevision)
        throw new BusinessRuleError('conflict', 'Expert references changed. Review the deletion impact again.', 'expert-stale')
      const blocked = preview.blocked.flatMap(row => row.references)
      if (blocked.length)
        throw new BusinessRuleError('conflict', 'Suite entries are still referenced.', 'runtime-dependency-referenced', {
          references: blocked.map(row => `${row.kind}: ${row.name}`).join(', '),
        })
      if (request.removeDependencies?.some(dependency => !record.dependencies?.includes(dependency))) throw invalidRequest()
      const kept = preview.dependencies.filter(row => row.references.length && request.removeDependencies?.includes(row.id))
      if (kept.length)
        throw new BusinessRuleError('conflict', 'Suite entries are still referenced.', 'runtime-dependency-referenced', {
          references: kept.flatMap(row => row.references.map(reference => `${reference.kind}: ${reference.name}`)).join(', '),
        })
      this.assertOpen()
      const task = await this.begin(accepted, installed, 'uninstalling', 'Uninstalling…')
      this.claim(task.record)
      this.start(id, async () => {
        try {
          await this.retirement.remove(accepted, task, preview.expertRevision)
        } catch (error) {
          await this.failTask(task, suitePreparationFailure(error), 'Uninstall failed; the installed entries remain in use.')
        }
        // Explicit shared removals follow the primary removal and recheck their current consumers.
        if (!(await this.storage.installs.get(id)))
          for (const dependency of request.removeDependencies ?? []) {
            const current = await this.storage.installs.get(dependency)
            if (current) await this.retirement.remove(accepted, current).catch(() => console.warn('Shared catalog dependency removal deferred.'))
          }
        await this.synchronize()
      })
    })
  }
  async detach(actor: CommunityAccountActor, id: string, input: unknown): Promise<void> {
    const accepted = structuredClone(actor),
      value = structuredClone(input)
    this.assertOpen()
    await this.operations.run('catalog', async () => {
      this.assertOpen()
      await this.assertAdmin(accepted)
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'kind' && key !== 'name'))
        throw invalidRequest()
      const installed = await this.queries.installed(id),
        { kind, name } = value as { kind?: unknown; name?: unknown },
        target = installed.record.entries.find(row => row.kind === kind && row.name === name)
      if (!target) throw new BusinessRuleError('missing', 'This entry is not part of the suite.', 'suite-entry-missing')
      this.assertOpen()
      try {
        await this.retirement.detach(accepted, installed, target)
      } catch (error) {
        const current = await this.storage.installs.get(id)
        if (!current?.record.detached?.some(row => row.kind === target.kind && row.name === target.name)) throw error
      }
      await this.synchronize()
    })
  }
  /** A restart ends interrupted external preparations; business facts never need compensation. */
  async recover(): Promise<void> {
    await this.storage.work.run(async rows => {
      await rows.requests.lockLedger()
      for (const task of await rows.installs.list()) {
        const record = task.record
        if (this.jobs.has(record.id) || ['installed', 'failed'].includes(record.status)) continue
        await rows.installs.save(
          {
            ...record,
            status: record.status === 'installing' ? 'failed' : 'installed',
            failureCode: 'interrupted',
            updatedAt: this.clock.now(),
            log: record.log + '\nPreparation was interrupted. Retry the operation.',
          },
          task.revision,
        )
        if (record.requestId && record.status === 'installing') {
          const request = await rows.requests.get(record.requestId)
          if (request?.result.id === record.id && request.result.status === 'pending')
            await rows.requests.save(record.requestId, { ...request.result, status: 'failed' }, request.revision)
        }
      }
    })
    this.claims.clear()
    this.replacementClaims.clear()
    await this.synchronize()
  }
  async stop(): Promise<void> {
    this.shutdown.abort()
    await this.operations.drain()
    await Promise.allSettled([...this.active])
  }
  private start(id: string, run: () => Promise<void>): void {
    const job = run().finally(() => {
      this.active.delete(job)
      if (this.jobs.get(id) !== job) return
      this.jobs.delete(id)
      this.claims.delete(id)
      this.replacementClaims.delete(id)
    })
    this.jobs.set(id, job)
    this.active.add(job)
    void job.catch(() => console.warn('Catalog task cleanup deferred; read the persisted task result.'))
  }
  private claim(record: CatalogInstallRecord): void {
    if (record.pluginPackage) this.claims.set(record.id, { packageName: record.pluginPackage, origin: suiteInstallOrigin(record.id) })
  }
  private async runInstall(
    actor: CommunityAccountActor,
    entries: readonly SuiteCatalogEntry[],
    options: SuiteInstallRequest,
    replacements: SuiteReplacements,
    installs: readonly CatalogInstallRow[],
    request: CatalogRequestRow,
    previous: readonly CatalogInstallRow[],
  ): Promise<void> {
    const lines: string[] = []
    try {
      const replacement: SuiteReplacementPlan = {
        dependencies: new Map(replacements.dependencies.map(row => [row.item, row.row])),
        skills: replacements.skills,
        executions: (await Promise.all(replacements.skills.map(row => this.execution?.suiteExecutionSnapshot(suiteExecutionOwner(row.name))))).flatMap(row =>
          row ? [row] : [],
        ),
        plugins: replacements.plugins,
      }
      await this.changes.install(
        actor,
        entries.map(entry => ({ entry, installed: installs.find(row => row.record.id === entry.id)!, ...(entry.id === options.id ? { replacement } : {}) })),
        options,
        request,
        async line => {
          lines.push(line)
        },
      )
    } catch (error) {
      await this.tasks.failInstall(
        installs,
        request,
        suitePreparationFailure(error),
        (error instanceof Error && !(error instanceof BusinessRuleError) ? error.message : 'Installation failed. Nothing was written.') +
          '\n' +
          lines.join('\n'),
        previous,
      )
    }
    await this.synchronize()
  }
  private begin(actor: CommunityAccountActor, task: CatalogInstallRow, status: 'updating' | 'uninstalling', line: string): Promise<CatalogInstallRow> {
    let committed: CatalogInstallRow | undefined
    return this.storage.work
      .run(
        async rows => {
          await rows.requests.lockLedger()
          await rows.accounts.lock(actor, actor, [])
          const record = await rows.installs.lock(task.record.id, task.revision)
          await rows.installs.save({ ...record, status, updatedAt: this.clock.now(), log: record.log + '\n---\n' + line }, task.revision)
          return (await rows.installs.get(record.id))!
        },
        value => {
          committed = value
        },
      )
      .catch(error => {
        if (committed) return committed
        throw error
      })
  }
  private failTask(task: CatalogInstallRow, failureCode: string, message: string): Promise<void> {
    return this.storage.work.run(async rows => {
      await rows.requests.lockLedger()
      const current = await rows.installs.get(task.record.id)
      if (current?.revision === task.revision)
        await rows.installs.save(
          { ...current.record, status: 'installed', failureCode, updatedAt: this.clock.now(), log: current.record.log + '\n' + message },
          current.revision,
        )
    })
  }
  private async synchronize(): Promise<void> {
    try {
      await this.skills.synchronizeContribution?.()
      await this.policy.changed?.()
      await this.dependencies.collectUnretained()
    } catch {
      console.warn('Catalog projections or artifact collection deferred; committed facts are retained.')
    }
  }
  private assertOpen(): void {
    if (this.shutdown.signal.aborted) throw new BusinessRuleError('conflict', 'Catalog operations are stopping.', 'suite-task-running')
  }
  private async assertAdmin(actor: CommunityAccountActor): Promise<void> {
    const account = await this.accounts.get(actor.username)
    if (!account || account.disabled || account.spaceId !== actor.spaceId || account.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!account.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required.', 'admin-required')
  }
}
