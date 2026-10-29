import type { CommunityPluginImpact, CommunityPluginView } from '../domain/admin-contract.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { sameContributionReceipt, type ContributionReceipt } from '../domain/contribution-receipt.js'
import { administratorLibraryVersion, completeAdministratorPluginSource } from '../domain/library-contribution.js'
import {
  assertPluginIdentity,
  assertPreparedPlugin,
  assertWritablePlugin,
  pluginIdentities,
  pluginLibraryView,
  PluginPreparationError,
  pluginReplacementProgress,
  type LibraryPlugin,
  type PluginCandidate,
  type PluginIdentity,
  type UploadedPlugin,
} from '../domain/plugin-library.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PlatformUnitOfWorkPort } from '../ports/platform-unit-of-work.js'
import type { PluginAccessStorePort } from '../ports/plugin-access.js'
import type {
  PluginLibraryMembershipPort,
  PluginLibraryStorePort,
  PluginPreparerPort,
  PluginUploadPort,
  PluginRemovalRepositories,
} from '../ports/plugin-library.js'
import type { PluginUpstreamsPort } from '../ports/plugin-upstreams.js'
import { PluginLibraryAdministration } from './plugin-library-administration.js'
import type { ExpertReferencesPort } from '../ports/experts.js'
import { PluginLibraryRemoval } from './plugin-library-removal.js'
import { PluginLibraryCatalog } from './plugin-library-catalog.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import { KeyedOperations } from './support/keyed-operations.js'

/** Owns durable additions and their in-flight preparation, including shutdown. */
export class PluginLibrary {
  private readonly tasks = new Map<string, { controller: AbortController; completion: Promise<void> }>()
  private readonly intake = new Set<{ controller: AbortController; completion: Promise<CommunityPluginView> }>()
  private stopped = false
  private readonly taskFailures: unknown[] = []
  /** Catalog plugin preparations staged under a suite origin; library rows appear only at commit. */
  private readonly administration: PluginLibraryAdministration
  private readonly catalog: PluginLibraryCatalog
  private readonly retirement: PluginLibraryRemoval
  /** Package names a running or restoring catalog task holds, derived from the persisted install records. */
  private suiteClaims?: () => readonly { packageName: string; origin: string }[]
  constructor(
    private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly store: PluginLibraryStorePort,
    private readonly preparer: PluginPreparerPort,
    private readonly uploads?: PluginUploadPort,
    membership?: PluginLibraryMembershipPort,
    private readonly compatibilityTarget?: string,
    settings?: {
      readonly access: Pick<PluginAccessStorePort, 'remove'> & Partial<Pick<PluginAccessStorePort, 'get' | 'clearSuiteCheckpoint'>>
      readonly upstreams: Pick<PluginUpstreamsPort, 'save'>
    },
    private readonly runtimeDependencies?: Pick<RuntimeDependencies, 'readReady'>,
    private readonly operations = new KeyedOperations(),
    removal?: PlatformUnitOfWorkPort<PluginRemovalRepositories>,
    expertReferences?: ExpertReferencesPort,
  ) {
    this.retirement = new PluginLibraryRemoval(store, membership, settings, removal, expertReferences)
    this.administration = new PluginLibraryAdministration(accounts, store, compatibilityTarget, settings, runtimeDependencies, operations, {
      assertAdmin: actor => this.assertAdmin(actor),
      assertIdle: name => this.assertIdle(name),
      assertWritable: name => this.assertWritable(name),
      confirm: (actor, name, revision) => this.confirm(actor, name, revision),
      required: name => this.required(name),
    })
    this.catalog = new PluginLibraryCatalog(store, preparer, membership, settings, compatibilityTarget, operations, {
      stopped: () => this.stopped,
      preparing: name => this.tasks.has(name),
      claims: () => this.suiteClaims?.() ?? [],
      assertIdle: name => this.assertIdle(name),
      remove: name => this.finishRemoval(name),
    })
  }
  /** The suite catalog registers the package names its persisted install intents hold. */
  observeSuiteClaims(claims: () => readonly { packageName: string; origin: string }[]): void {
    this.suiteClaims = claims
  }
  async recover(): Promise<void> {
    for (const row of await this.store.list())
      if (row.stage !== 'available' && row.stage !== 'failed') await this.store.save({ ...row, stage: 'failed', failureCode: 'plugin-job-interrupted' })
    for (const row of await this.store.list())
      if (row.replacement && !['available', 'failed'].includes(row.replacement.stage))
        await this.store.save({ ...row, replacement: { ...row.replacement, stage: 'failed', failureCode: 'plugin-job-interrupted' } })

    await this.preparer.recover?.()
    await this.uploads?.recover?.(
      (await this.store.list()).flatMap(row => [row.upload?.archive, row.replacement?.upload?.archive].filter((path): path is string => path !== undefined)),
    )
  }
  async list(actor: CommunityAccountActor): Promise<readonly CommunityPluginView[]> {
    await this.assertAdmin(actor)
    return (await this.store.list()).map(row => pluginLibraryView(row))
  }
  async contributionAdopted(packageName: string, integrity: string, receipt?: ContributionReceipt): Promise<boolean> {
    return (await this.store.list()).some(
      row =>
        row.packageName === packageName &&
        row.current?.integrity === integrity &&
        row.stage === 'available' &&
        (!receipt || sameContributionReceipt(row.contributionReceipt, receipt)),
    )
  }
  adoptContribution(...args: Parameters<PluginLibraryAdministration['adoptContribution']>): ReturnType<PluginLibraryAdministration['adoptContribution']> {
    return this.administration.adoptContribution(...args)
  }
  setRuntimeDependencies(
    ...args: Parameters<PluginLibraryAdministration['setRuntimeDependencies']>
  ): ReturnType<PluginLibraryAdministration['setRuntimeDependencies']> {
    return this.administration.setRuntimeDependencies(...args)
  }
  setMaintainer(...args: Parameters<PluginLibraryAdministration['setMaintainer']>): ReturnType<PluginLibraryAdministration['setMaintainer']> {
    return this.administration.setMaintainer(...args)
  }
  async add(actor: CommunityAccountActor, input: PluginIdentity, retry = false): Promise<CommunityPluginView> {
    return await this.operations.run(input.packageName, async () => {
      await this.assertAdmin(actor)
      assertPluginIdentity(input)
      if (this.stopped) throw new BusinessRuleError('conflict', 'Plugin preparation is stopping.', 'plugin-job-interrupted')
      await this.assertWritable(input.packageName)
      const existing = (await this.store.list()).find(row => row.packageName === input.packageName)
      if (existing?.removing) throw new BusinessRuleError('conflict', 'Plugin removal is pending.', 'plugin-job-busy')
      if (existing && existing.version !== input.version)
        throw new BusinessRuleError('conflict', 'This package is already in the library.', 'plugin-name-in-use')
      if (existing && (!retry || existing.stage !== 'failed' || this.tasks.has(input.packageName))) return pluginLibraryView(existing)
      const row: LibraryPlugin = {
        ...input,
        runtimeDependencies: existing?.runtimeDependencies ?? [],
        ...(existing
          ? {
              ...(existing.provenance ? { provenance: existing.provenance } : {}),
              ...(existing.pendingAdministrator ? { pendingAdministrator: existing.pendingAdministrator } : {}),
              ...(existing.contributionReceipt ? { contributionReceipt: existing.contributionReceipt } : {}),
              identities: pluginIdentities(existing),
              ...(existing.replacement ? { replacement: existing.replacement } : {}),
            }
          : {}),
        ...(existing?.upload ? { upload: existing.upload } : {}),
        ...(existing?.current ? { retainedIntegrity: existing.current.integrity } : {}),
        ...(existing?.incompatible ? { incompatible: true } : {}),
        restorePublication: existing?.restorePublication === true || existing?.published === true,
        stage: 'resolving',
        current: existing?.current ?? null,
        published: false,
      }
      return await this.enqueue(row, actor)
    })
  }
  async impact(actor: CommunityAccountActor, packageName: string): Promise<CommunityPluginImpact> {
    await this.assertAdmin(actor)
    return await this.retirement.impact(packageName)
  }
  async replace(actor: CommunityAccountActor, input: PluginIdentity): Promise<CommunityPluginView> {
    return await this.operations.run(input.packageName, async () => {
      await this.assertAdmin(actor)
      assertPluginIdentity(input)
      this.assertIdle(input.packageName)
      await this.assertWritable(input.packageName)
      return await this.enqueueReplacement(input)
    })
  }
  private async enqueueReplacement(input: PluginCandidate): Promise<CommunityPluginView> {
    const row = await this.required(input.packageName)
    if (row.removing) throw new BusinessRuleError('conflict', 'Plugin removal is pending.', 'plugin-job-busy')
    const replacement = { ...input, stage: 'resolving' as const, prepared: null }
    const identities = { ...pluginIdentities(row), ...(input.upload ? { [input.version]: input.upload.integrity } : {}) }
    await this.store.save({ ...row, identities, replacement })
    this.track(input.packageName, signal =>
      this.prepare({ ...input, stage: 'resolving', current: null, published: false }, signal, result =>
        this.operations.run(input.packageName, async () => {
          const current = await this.required(input.packageName)
          await this.store.save(pluginReplacementProgress(current, result))
        }),
      ),
    )
    return pluginLibraryView(await this.required(input.packageName))
  }
  async select(actor: CommunityAccountActor, packageName: string, revision: string): Promise<CommunityPluginView> {
    return await this.operations.run(packageName, async () => {
      await this.assertAdmin(actor)
      const row = await this.required(packageName)
      const replacement = row.replacement
      if (row.removing || !replacement?.prepared || replacement.stage !== 'available')
        throw new BusinessRuleError('conflict', 'Precheck the replacement version first.', 'plugin-candidate-unavailable')
      this.assertIdle(packageName)
      await this.assertWritable(packageName)
      await this.confirm(actor, packageName, revision)
      const next: LibraryPlugin = {
        packageName,
        runtimeDependencies: row.runtimeDependencies ?? [],
        version: replacement.version,
        ...(replacement.upload ? { upload: replacement.upload } : {}),
        provenance: administratorLibraryVersion(row.provenance, replacement.version, replacement.prepared.integrity, actor, Date.now()),
        current: replacement.prepared,
        stage: 'available',
        published: row.published || row.restorePublication === true,
        ...(this.compatibilityTarget ? { checkedFor: this.compatibilityTarget } : {}),
        identities: pluginIdentities(row),
      }
      await this.store.save(next)
      return pluginLibraryView(next)
    })
  }
  async remove(actor: CommunityAccountActor, packageName: string, revision: string): Promise<void> {
    return await this.operations.run(packageName, async () => {
      await this.assertAdmin(actor)
      this.assertIdle(packageName)
      await this.assertWritable(packageName)
      await this.retirement.remove(packageName, revision)
    })
  }
  private async finishRemoval(packageName: string): Promise<void> {
    await this.retirement.finish(packageName)
  }
  private async confirm(actor: CommunityAccountActor, packageName: string, revision: string): Promise<void> {
    if ((await this.impact(actor, packageName)).revision !== revision)
      throw new BusinessRuleError('conflict', 'The plugin impact changed. Review it again.', 'plugin-impact-changed')
  }
  private async required(packageName: string): Promise<LibraryPlugin> {
    const row = (await this.store.list()).find(row => row.packageName === packageName)
    if (!row) throw new BusinessRuleError('missing', 'Plugin was not found.', 'plugin-market-unavailable')
    return row
  }
  private assertIdle(packageName: string): void {
    if (this.stopped) throw new BusinessRuleError('conflict', 'Plugin preparation is stopping.', 'plugin-job-interrupted')
    if (this.tasks.has(packageName)) throw new BusinessRuleError('conflict', 'Wait for the plugin precheck to finish.', 'plugin-job-busy')
  }
  /** Rows a catalog entry owns are read-only; package names its running tasks hold are busy for manual changes. */
  private async assertWritable(packageName: string): Promise<void> {
    assertWritablePlugin(
      (await this.store.list()).find(row => row.packageName === packageName),
      packageName,
      this.suiteClaims?.() ?? [],
    )
  }
  private track(packageName: string, run: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController()
    const completion = run(controller.signal)
    this.tasks.set(packageName, { controller, completion })
    void completion.then(
      () => this.tasks.delete(packageName),
      error => {
        this.taskFailures.push(error)
        this.tasks.delete(packageName)
      },
    )
  }
  private async enqueue(row: LibraryPlugin, administrator?: CommunityAccountActor): Promise<CommunityPluginView> {
    row =
      administrator && !row.current && !row.pendingAdministrator
        ? {
            ...row,
            pendingAdministrator: {
              actor: { username: administrator.username, spaceId: administrator.spaceId, sessionEpoch: administrator.sessionEpoch },
              submittedAt: Date.now(),
            },
          }
        : row
    await this.store.save(row)
    this.track(row.packageName, signal => this.prepare(row, signal))
    return pluginLibraryView(row)
  }
  async upload(
    actor: CommunityAccountActor,
    filename: string,
    content: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    replacing?: string,
  ): Promise<CommunityPluginView> {
    await this.assertAdmin(actor)
    if (this.stopped) throw new BusinessRuleError('conflict', 'Plugin preparation is stopping.', 'plugin-job-interrupted')
    if (!this.uploads) throw new PluginPreparationError('plugin-runtime-required')
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const completion = this.receiveUpload(actor, filename, content, controller.signal, replacing)
    const intake = { controller, completion }
    this.intake.add(intake)
    try {
      return await completion
    } finally {
      this.intake.delete(intake)
      signal.removeEventListener('abort', abort)
    }
  }
  private async receiveUpload(
    actor: CommunityAccountActor,
    filename: string,
    content: AsyncIterable<Uint8Array>,
    signal: AbortSignal,
    replacing?: string,
  ): Promise<CommunityPluginView> {
    let uploaded: UploadedPlugin | undefined
    let accepted = false
    try {
      uploaded = await this.uploads!.accept(filename, content, signal)
      signal.throwIfAborted()
      const candidate = uploaded
      return await this.operations.run(candidate.packageName, async () => {
        await this.assertAdmin(actor)
        assertPluginIdentity(candidate)
        if (this.stopped) throw new PluginPreparationError('plugin-job-interrupted')
        // Re-checked after the upload await: a catalog task may have claimed the package meanwhile.
        await this.assertWritable(candidate.packageName)
        const existing = (await this.store.list()).find(row => row.packageName === candidate.packageName)
        if (replacing !== undefined) {
          if (replacing !== candidate.packageName || !existing) throw new PluginPreparationError('plugin-package-invalid')
          this.assertIdle(replacing)
          if (pluginIdentities(existing)[candidate.version] !== undefined && pluginIdentities(existing)[candidate.version] !== candidate.integrity)
            throw new BusinessRuleError('conflict', 'This version already has different content.', 'plugin-version-conflict')
          const result = await this.enqueueReplacement({
            packageName: candidate.packageName,
            version: candidate.version,
            upload: { archive: candidate.archive, integrity: candidate.integrity },
          })
          accepted = true
          return result
        }
        if (existing) {
          if (existing.version !== candidate.version) throw new BusinessRuleError('conflict', 'This package is already in the library.', 'plugin-name-in-use')
          if ((existing.upload?.integrity ?? existing.current?.integrity) !== candidate.integrity)
            throw new BusinessRuleError('conflict', 'This package version already has different or unverified content.', 'plugin-version-conflict')
          return pluginLibraryView(existing)
        }
        const result = await this.enqueue(
          {
            packageName: candidate.packageName,
            version: candidate.version,
            upload: { archive: candidate.archive, integrity: candidate.integrity },
            stage: 'resolving',
            current: null,
            published: false,
          },
          actor,
        )
        accepted = true
        return result
      })
    } finally {
      if (uploaded && !accepted) await this.uploads!.discard(uploaded.archive)
    }
  }
  async drain(): Promise<void> {
    await this.operations.drain()
    const results = await Promise.allSettled(
      [...this.tasks.values()]
        .map(task => task.completion)
        .concat(
          [...this.intake].map(task =>
            task.completion.then(
              () => {},
              () => {},
            ),
          ),
        ),
    )
    const failures = [...new Set([...this.taskFailures, ...results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))])]
    if (failures.length) throw new AggregateError(failures, 'Plugin preparation tasks failed')
  }
  async stop(): Promise<void> {
    this.stopped = true
    await this.operations.drain()
    for (const task of [...this.tasks.values(), ...this.intake]) task.controller.abort()
    await this.drain()
  }
  private async prepare(
    row: LibraryPlugin,
    signal: AbortSignal,
    persist: (row: LibraryPlugin) => Promise<void> = value =>
      this.operations.run(value.packageName, async () => {
        const latest = await this.required(value.packageName)
        await this.store.save({
          ...value,
          ...(latest.revision !== undefined ? { revision: latest.revision } : {}),
          runtimeDependencies: latest.runtimeDependencies ?? [],
          published: value.stage === 'available' ? latest.published || latest.restorePublication === true : latest.published,
          restorePublication: value.stage === 'available' ? false : latest.restorePublication === true,
        })
      }),
  ): Promise<void> {
    try {
      const prepared = await this.preparer.prepare(
        row,
        async stage => {
          signal.throwIfAborted()
          await persist({ ...row, stage })
        },
        signal,
      )
      signal.throwIfAborted()
      assertPreparedPlugin(row, prepared, pluginIdentities(await this.required(row.packageName))[prepared.version])
      const ready = { ...row }
      delete ready.incompatible
      delete ready.failureCode
      delete ready.retainedIntegrity
      await persist(
        completeAdministratorPluginSource({
          ...ready,
          stage: 'available',
          current: prepared,
          published: row.published || row.restorePublication === true,
          restorePublication: false,
          ...(this.compatibilityTarget ? { checkedFor: this.compatibilityTarget } : {}),
        }),
      )
    } catch (error) {
      await persist({
        ...row,
        stage: 'failed',
        failureCode:
          error instanceof PluginPreparationError && error.code === 'plugin-cleanup-failed'
            ? error.code
            : signal.aborted
              ? 'plugin-job-interrupted'
              : error instanceof PluginPreparationError
                ? error.code
                : 'plugin-precheck-failed',
      })
    }
  }
  assertSuiteAdmission(...args: Parameters<PluginLibraryCatalog['assertSuiteAdmission']>): ReturnType<PluginLibraryCatalog['assertSuiteAdmission']> {
    return this.catalog.assertSuiteAdmission(...args)
  }
  suitePluginRow(...args: Parameters<PluginLibraryCatalog['suitePluginRow']>): ReturnType<PluginLibraryCatalog['suitePluginRow']> {
    return this.catalog.suitePluginRow(...args)
  }
  suitePluginConflicts(...args: Parameters<PluginLibraryCatalog['suitePluginConflicts']>): ReturnType<PluginLibraryCatalog['suitePluginConflicts']> {
    return this.catalog.suitePluginConflicts(...args)
  }
  suitePluginReplaceable(...args: Parameters<PluginLibraryCatalog['suitePluginReplaceable']>): ReturnType<PluginLibraryCatalog['suitePluginReplaceable']> {
    return this.catalog.suitePluginReplaceable(...args)
  }
  suitePluginImpact(...args: Parameters<PluginLibraryCatalog['suitePluginImpact']>): ReturnType<PluginLibraryCatalog['suitePluginImpact']> {
    return this.catalog.suitePluginImpact(...args)
  }
  prepareSuitePlugin(...args: Parameters<PluginLibraryCatalog['prepareSuitePlugin']>): ReturnType<PluginLibraryCatalog['prepareSuitePlugin']> {
    return this.catalog.prepareSuitePlugin(...args)
  }
  commitSuitePlugin(...args: Parameters<PluginLibraryCatalog['commitSuitePlugin']>): ReturnType<PluginLibraryCatalog['commitSuitePlugin']> {
    return this.catalog.commitSuitePlugin(...args)
  }
  restoreSuitePlugin(...args: Parameters<PluginLibraryCatalog['restoreSuitePlugin']>): ReturnType<PluginLibraryCatalog['restoreSuitePlugin']> {
    return this.catalog.restoreSuitePlugin(...args)
  }
  dropSuitePluginRow(...args: Parameters<PluginLibraryCatalog['dropSuitePluginRow']>): ReturnType<PluginLibraryCatalog['dropSuitePluginRow']> {
    return this.catalog.dropSuitePluginRow(...args)
  }
  restoreSuiteAccessBaseline(
    ...args: Parameters<PluginLibraryCatalog['restoreSuiteAccessBaseline']>
  ): ReturnType<PluginLibraryCatalog['restoreSuiteAccessBaseline']> {
    return this.catalog.restoreSuiteAccessBaseline(...args)
  }
  discardSuitePlugin(...args: Parameters<PluginLibraryCatalog['discardSuitePlugin']>): ReturnType<PluginLibraryCatalog['discardSuitePlugin']> {
    return this.catalog.discardSuitePlugin(...args)
  }
  removeSuitePlugin(...args: Parameters<PluginLibraryCatalog['removeSuitePlugin']>): ReturnType<PluginLibraryCatalog['removeSuitePlugin']> {
    return this.catalog.removeSuitePlugin(...args)
  }
  detachSuitePlugin(...args: Parameters<PluginLibraryCatalog['detachSuitePlugin']>): ReturnType<PluginLibraryCatalog['detachSuitePlugin']> {
    return this.catalog.detachSuitePlugin(...args)
  }
  private async assertAdmin(actor: CommunityAccountActor): Promise<void> {
    const current = await this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
