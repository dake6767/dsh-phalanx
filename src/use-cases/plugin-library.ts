import { assertPluginDependencyTemplate, pluginAccessIdentity } from '../domain/plugin-access.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import { sameContributionReceipt, type ContributionReceipt } from '../domain/contribution-receipt.js'
import { completeAdministratorPluginSource, libraryProvenanceRevision, administratorLibraryVersion, assertPluginContributionVersion, libraryContributionProvenance, type LibraryContributionAdoption } from '../domain/library-contribution.js'
import { redactContributionContent } from '../domain/contribution-checks.js'
import type { PluginAccessStorePort } from '../ports/plugin-access.js'
import type { PluginUpstreamsPort } from '../ports/plugin-upstreams.js'
import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityPluginView, CommunityPluginImpact } from '../domain/admin-contract.js'
import { pluginCatalogRevision, assertPluginIdentity, assertPreparedPlugin, PluginPreparationError, type LibraryPlugin, type PluginIdentity, type UploadedPlugin, type PluginCandidate } from '../domain/plugin-library.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort, PluginPreparerPort, PluginUploadPort, PluginLibraryMembershipPort } from '../ports/plugin-library.js'

/** Owns durable additions and their in-flight preparation, including shutdown. */
export class PluginLibrary {
  private readonly tasks = new Map<string, { controller: AbortController, completion: Promise<void> }>()
  private readonly intake = new Set<{ controller: AbortController, completion: Promise<CommunityPluginView> }>()
  private stopped = false
  private readonly taskFailures: unknown[] = []
  /** Catalog plugin preparations staged under a suite origin; library rows appear only at commit. */
  private readonly suiteStaged = new Map<string, import('../domain/plugin-library.js').PreparedPlugin>()
  /** Package names a running or restoring catalog task holds, derived from the persisted install records. */
  private suiteClaims?: () => readonly { packageName: string, origin: string }[]
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly store: PluginLibraryStorePort, private readonly preparer: PluginPreparerPort, private readonly uploads?: PluginUploadPort, private readonly membership?: PluginLibraryMembershipPort, private readonly compatibilityTarget?: string, private readonly settings?: { readonly access: Pick<PluginAccessStorePort, 'remove'> & Partial<Pick<PluginAccessStorePort, 'get' | 'clearSuiteCheckpoint'>>, readonly upstreams: Pick<PluginUpstreamsPort, 'save'> }, private readonly runtimeDependencies?: Pick<RuntimeDependencies, 'ready'>) {
    for (const row of store.list()) if (row.stage !== 'available' && row.stage !== 'failed')
      store.save({ ...row, stage: 'failed', failureCode: 'plugin-job-interrupted' })
    for (const row of store.list()) if (row.replacement && !['available', 'failed'].includes(row.replacement.stage))
      store.save({ ...row, replacement: { ...row.replacement, stage: 'failed', failureCode: 'plugin-job-interrupted' } })
  }
  /** The suite catalog registers the package names its persisted install intents hold. */
  observeSuiteClaims(claims: () => readonly { packageName: string, origin: string }[]): void { this.suiteClaims = claims }
  async recover(): Promise<void> {
    await this.preparer.recover?.()
    for (const row of this.store.list()) if (row.removing) this.finishRemoval(row.packageName)
    await this.uploads?.recover?.(this.store.list().flatMap(row => [row.upload?.archive, row.replacement?.upload?.archive].filter((path): path is string => path !== undefined)))
  }
  list(actor: CommunityAccountActor): readonly CommunityPluginView[] {
    this.assertAdmin(actor); return this.store.list().map(row => this.view(row))
  }
  contributionAdopted(packageName: string, integrity: string, receipt?: ContributionReceipt): boolean { return this.store.list().some(row => row.packageName === packageName && row.current?.integrity === integrity && row.stage === 'available' && (!receipt || sameContributionReceipt(row.contributionReceipt, receipt))) }
  /** A contribution has already passed the same isolated preparer; selection still belongs to this owner. */
  adoptContribution(actor: CommunityAccountActor, candidate: PluginCandidate, prepared: import('../domain/plugin-library.js').PreparedPlugin, revision: string, contribution: { readonly id: string, readonly revision: string, readonly checkedFor?: string, readonly adoption?: LibraryContributionAdoption }, committed: () => void): void {
    this.assertAdmin(actor); assertPluginIdentity(candidate); this.assertIdle(candidate.packageName); this.assertWritable(candidate.packageName)
    if (this.compatibilityTarget && (contribution.checkedFor !== this.compatibilityTarget || prepared.runtimeRevision !== this.compatibilityTarget.split('/').at(-1))) throw new PluginPreparationError('plugin-incompatible')
    const existing = this.store.list().find(row => row.packageName === candidate.packageName)
    if (existing) { if (existing.removing) throw new BusinessRuleError('conflict', 'Plugin removal is pending.', 'plugin-job-busy'); this.confirm(actor, candidate.packageName, revision) }
    else if (revision !== 'new') throw new BusinessRuleError('conflict', 'Review the changed plugin impact.', 'plugin-impact-changed')
    let provenance = existing?.provenance
    if (contribution.adoption) {
      const submitted = contribution.adoption.row
      if (this.accounts.get(submitted.contributor.username)?.spaceId !== submitted.contributor.spaceId) throw new BusinessRuleError('conflict', 'The contributor account changed.', 'contribution-unavailable')
      assertPluginContributionVersion(candidate.version, existing?.current?.version)
      provenance = libraryContributionProvenance(provenance, contribution.adoption, !!existing)
    }
    const identities = existing ? this.identities(existing) : {}
    assertPreparedPlugin(candidate, prepared, identities[candidate.version])
    this.store.save({ ...candidate, runtimeDependencies: existing?.runtimeDependencies ?? [], ...(provenance ? { provenance } : {}), contributionReceipt: { id: contribution.id, revision: contribution.revision }, current: prepared, stage: 'available', published: existing?.published === true || existing?.restorePublication === true, identities: { ...identities, [candidate.version]: prepared.integrity }, ...(this.compatibilityTarget ? { checkedFor: this.compatibilityTarget } : {}) })
    committed()
  }
  add(actor: CommunityAccountActor, input: PluginIdentity, retry = false): CommunityPluginView {
    this.assertAdmin(actor); assertPluginIdentity(input)
    if (this.stopped) throw new BusinessRuleError('conflict', 'Plugin preparation is stopping.', 'plugin-job-interrupted')
    this.assertWritable(input.packageName)
    const existing = this.store.list().find(row => row.packageName === input.packageName)
    if (existing?.removing) throw new BusinessRuleError('conflict', 'Plugin removal is pending.', 'plugin-job-busy')
    if (existing && existing.version !== input.version) throw new BusinessRuleError('conflict', 'This package is already in the library.', 'plugin-name-in-use')
    if (existing && (!retry || existing.stage !== 'failed' || this.tasks.has(input.packageName))) return this.view(existing)
    const row: LibraryPlugin = { ...input, runtimeDependencies: existing?.runtimeDependencies ?? [], ...(existing ? { ...(existing.provenance ? { provenance: existing.provenance } : {}), ...(existing.pendingAdministrator ? { pendingAdministrator: existing.pendingAdministrator } : {}), ...(existing.contributionReceipt ? { contributionReceipt: existing.contributionReceipt } : {}), identities: this.identities(existing), ...(existing.replacement ? { replacement: existing.replacement } : {}) } : {}), ...(existing?.upload ? { upload: existing.upload } : {}), ...(existing?.current ? { retainedIntegrity: existing.current.integrity } : {}), ...(existing?.incompatible ? { incompatible: true } : {}), restorePublication: existing?.restorePublication === true || existing?.published === true, stage: 'resolving', current: existing?.current ?? null, published: false }
    return this.enqueue(row, actor)
  }
  impact(actor: CommunityAccountActor, packageName: string): CommunityPluginImpact {
    this.assertAdmin(actor)
    const row = this.required(packageName)
    if (!this.membership) throw new BusinessRuleError('invalid', 'Plugin changes are unavailable.', 'plugin-action-invalid')
    const impact = this.membership.impact(packageName)
    return { ...impact, revision: JSON.stringify([row.version, row.current?.integrity, row.replacement?.prepared?.integrity, row.removing, libraryProvenanceRevision(row.provenance), impact]) }
  }
  replace(actor: CommunityAccountActor, input: PluginIdentity): CommunityPluginView {
    this.assertAdmin(actor); assertPluginIdentity(input); this.assertIdle(input.packageName); this.assertWritable(input.packageName)
    return this.enqueueReplacement(input)
  }
  private enqueueReplacement(input: PluginCandidate): CommunityPluginView {
    const row = this.required(input.packageName)
    if (row.removing) throw new BusinessRuleError('conflict', 'Plugin removal is pending.', 'plugin-job-busy')
    const replacement = { ...input, stage: 'resolving' as const, prepared: null }
    const identities = { ...this.identities(row), ...(input.upload ? { [input.version]: input.upload.integrity } : {}) }
    this.store.save({ ...row, identities, replacement })
    this.track(input.packageName, signal => this.prepare({ ...input, stage: 'resolving', current: null, published: false }, signal, result => {
      const current = this.required(input.packageName)
      this.store.save({ ...current, identities: { ...this.identities(current), ...(result.current ? { [result.version]: result.current.integrity } : {}) }, replacement: { packageName: result.packageName, version: result.version, stage: result.stage,
        prepared: result.current, ...(result.upload ? { upload: result.upload } : {}), ...(result.failureCode ? { failureCode: result.failureCode } : {}) } })
    }))
    return this.view(this.required(input.packageName))
  }
  select(actor: CommunityAccountActor, packageName: string, revision: string): CommunityPluginView {
    this.assertAdmin(actor)
    const row = this.required(packageName); const replacement = row.replacement
    if (row.removing || !replacement?.prepared || replacement.stage !== 'available') throw new BusinessRuleError('conflict', 'Precheck the replacement version first.', 'plugin-candidate-unavailable')
    this.assertIdle(packageName); this.assertWritable(packageName); this.confirm(actor, packageName, revision)
    const next: LibraryPlugin = { packageName, runtimeDependencies: row.runtimeDependencies ?? [], version: replacement.version, ...(replacement.upload ? { upload: replacement.upload } : {}),
      provenance: administratorLibraryVersion(row.provenance, replacement.version, replacement.prepared.integrity, actor, Date.now()), current: replacement.prepared, stage: 'available', published: row.published || row.restorePublication === true, ...(this.compatibilityTarget ? { checkedFor: this.compatibilityTarget } : {}), identities: this.identities(row) }
    this.store.save(next); return this.view(next)
  }
  remove(actor: CommunityAccountActor, packageName: string, revision: string): void {
    this.assertAdmin(actor); this.assertIdle(packageName); this.assertWritable(packageName); this.confirm(actor, packageName, revision)
    this.store.save({ ...this.required(packageName), removing: true, published: false })
    this.finishRemoval(packageName)
  }
  private finishRemoval(packageName: string): void {
    if (!this.membership) throw new Error('Plugin membership is required for removal recovery')
    this.membership.revoke(packageName)
    this.settings?.access.remove(packageName)
    this.settings?.upstreams.save(packageName, [])
    this.store.remove(packageName)
  }
  private confirm(actor: CommunityAccountActor, packageName: string, revision: string): void {
    if (this.impact(actor, packageName).revision !== revision) throw new BusinessRuleError('conflict', 'The plugin impact changed. Review it again.', 'plugin-impact-changed')
  }
  private required(packageName: string): LibraryPlugin {
    const row = this.store.list().find(row => row.packageName === packageName)
    if (!row) throw new BusinessRuleError('missing', 'Plugin was not found.', 'plugin-market-unavailable')
    return row
  }
  private assertIdle(packageName: string): void {
    if (this.stopped) throw new BusinessRuleError('conflict', 'Plugin preparation is stopping.', 'plugin-job-interrupted')
    if (this.tasks.has(packageName)) throw new BusinessRuleError('conflict', 'Wait for the plugin precheck to finish.', 'plugin-job-busy')
  }
  /** Rows a catalog entry owns are read-only; package names its running tasks hold are busy for manual changes. */
  private assertWritable(packageName: string): void {
    const row = this.store.list().find(row => row.packageName === packageName)
    if (row?.suiteOrigin) throw new BusinessRuleError('forbidden', 'Suite catalog entries are read-only. Uninstall the catalog entry or detach the plugin first.', 'suite-entry-locked')
    if (this.suiteClaims?.().some(row => row.packageName === packageName)) throw new BusinessRuleError('conflict', 'A catalog task is preparing this plugin.', 'plugin-job-busy')
  }
  private track(packageName: string, run: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController()
    const completion = run(controller.signal)
    this.tasks.set(packageName, { controller, completion })
    void completion.then(() => this.tasks.delete(packageName), error => { this.taskFailures.push(error); this.tasks.delete(packageName) })
  }
  private enqueue(row: LibraryPlugin, administrator?: CommunityAccountActor): CommunityPluginView {
    row = administrator && !row.current && !row.pendingAdministrator ? { ...row, pendingAdministrator: { actor: { username: administrator.username, spaceId: administrator.spaceId, sessionEpoch: administrator.sessionEpoch }, submittedAt: Date.now() } } : row
    this.store.save(row)
    this.track(row.packageName, signal => this.prepare(row, signal))
    return this.view(row)
  }
  async upload(actor: CommunityAccountActor, filename: string, content: AsyncIterable<Uint8Array>, signal: AbortSignal, replacing?: string): Promise<CommunityPluginView> {
    this.assertAdmin(actor)
    if (this.stopped) throw new BusinessRuleError('conflict', 'Plugin preparation is stopping.', 'plugin-job-interrupted')
    if (!this.uploads) throw new PluginPreparationError('plugin-runtime-required')
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    const completion = this.receiveUpload(actor, filename, content, controller.signal, replacing)
    const intake = { controller, completion }; this.intake.add(intake)
    try { return await completion }
    finally { this.intake.delete(intake); signal.removeEventListener('abort', abort) }
  }
  private async receiveUpload(actor: CommunityAccountActor, filename: string, content: AsyncIterable<Uint8Array>, signal: AbortSignal, replacing?: string): Promise<CommunityPluginView> {
    let uploaded: UploadedPlugin | undefined
    let accepted = false
    try {
      uploaded = await this.uploads!.accept(filename, content, signal)
      signal.throwIfAborted(); this.assertAdmin(actor); assertPluginIdentity(uploaded)
      if (this.stopped) throw new PluginPreparationError('plugin-job-interrupted')
      // Re-checked after the upload await: a catalog task may have claimed the package meanwhile.
      this.assertWritable(uploaded.packageName)
      const existing = this.store.list().find(row => row.packageName === uploaded!.packageName)
      if (replacing !== undefined) {
        if (replacing !== uploaded.packageName || !existing) throw new PluginPreparationError('plugin-package-invalid')
        this.assertIdle(replacing)
        if (this.identities(existing)[uploaded.version] !== undefined && this.identities(existing)[uploaded.version] !== uploaded.integrity)
          throw new BusinessRuleError('conflict', 'This version already has different content.', 'plugin-version-conflict')
        const result = this.enqueueReplacement({ packageName: uploaded.packageName, version: uploaded.version, upload: { archive: uploaded.archive, integrity: uploaded.integrity } })
        accepted = true; return result
      }
      if (existing) {
        if (existing.version !== uploaded.version) throw new BusinessRuleError('conflict', 'This package is already in the library.', 'plugin-name-in-use')
        if ((existing.upload?.integrity ?? existing.current?.integrity) !== uploaded.integrity)
          throw new BusinessRuleError('conflict', 'This package version already has different or unverified content.', 'plugin-version-conflict')
        return this.view(existing)
      }
      const result = this.enqueue({ packageName: uploaded.packageName, version: uploaded.version, upload: { archive: uploaded.archive, integrity: uploaded.integrity }, stage: 'resolving', current: null, published: false }, actor)
      accepted = true
      return result
    } finally { if (uploaded && !accepted) await this.uploads!.discard(uploaded.archive) }
  }
  async drain(): Promise<void> {
    const results = await Promise.allSettled([...this.tasks.values()].map(task => task.completion).concat([...this.intake].map(task => task.completion.then(() => {}, () => {}))))
    const failures = [...new Set([...this.taskFailures, ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])])]
    if (failures.length) throw new AggregateError(failures, 'Plugin preparation tasks failed')
  }
  async stop(): Promise<void> {
    this.stopped = true
    for (const task of [...this.tasks.values(), ...this.intake]) task.controller.abort()
    await this.drain()
  }
  private async prepare(row: LibraryPlugin, signal: AbortSignal, persist: (row: LibraryPlugin) => void = value => {
    const latest = this.required(value.packageName)
    this.store.save({ ...value, runtimeDependencies: latest.runtimeDependencies ?? [], published: value.stage === 'available' ? latest.published || latest.restorePublication === true : latest.published,
      restorePublication: value.stage === 'available' ? false : latest.restorePublication === true })
  }): Promise<void> {
    try {
      const prepared = await this.preparer.prepare(row, stage => { signal.throwIfAborted(); persist({ ...row, stage }) }, signal)
      signal.throwIfAborted()
      assertPreparedPlugin(row, prepared, this.identities(this.required(row.packageName))[prepared.version])
      const ready = { ...row }; delete ready.incompatible; delete ready.failureCode; delete ready.retainedIntegrity
      persist(completeAdministratorPluginSource({ ...ready, stage: 'available', current: prepared, published: row.published || row.restorePublication === true, restorePublication: false,
        ...(this.compatibilityTarget ? { checkedFor: this.compatibilityTarget } : {}) }))
    } catch (error) {
      persist({ ...row, stage: 'failed', failureCode: error instanceof PluginPreparationError && error.code === 'plugin-cleanup-failed' ? error.code
        : signal.aborted ? 'plugin-job-interrupted' : error instanceof PluginPreparationError ? error.code : 'plugin-precheck-failed' })
    }
  }
  private identities(row?: LibraryPlugin): Readonly<Record<string, string>> {
    return { ...row?.identities, ...(row?.upload ? { [row.version]: row.upload.integrity } : {}), ...(row?.current ? { [row.current.version]: row.current.integrity } : {}),
      ...(row?.replacement?.upload ? { [row.replacement.version]: row.replacement.upload.integrity } : {}), ...(row?.replacement?.prepared ? { [row.replacement.version]: row.replacement.prepared.integrity } : {}) }
  }
  private view(row: LibraryPlugin): CommunityPluginView {
    return { ...(row.suiteOrigin ? { suiteOrigin: row.suiteOrigin } : {}), runtimeDependencies: row.runtimeDependencies ?? [], ...(row.provenance ? { provenance: row.provenance } : {}), maintenanceRevision: this.maintenanceRevision(row), ...(row.incompatible ? { incompatible: true } : {}), ...(row.restorePublication ? { publicationPaused: true } : {}), ...(row.removing ? { removing: true } : {}), ...(row.replacement ? { replacement: { version: row.replacement.version, stage: row.replacement.stage, ...(row.replacement.failureCode ? { failureCode: row.replacement.failureCode } : {}) } } : {}), source: row.upload ? 'upload' : 'npm', packageName: row.packageName, version: row.version, currentVersion: row.current?.version ?? null,
      title: row.contributionReceipt ? redactContributionContent(row.current?.title ?? row.packageName) : row.current?.title ?? row.packageName, description: row.contributionReceipt ? redactContributionContent(row.current?.description ?? '') : row.current?.description ?? '', stage: row.stage,
      published: row.published, ...(row.current ? { integrity: row.current.integrity } : {}), ...(row.failureCode ? { failureCode: row.failureCode } : {}) }
  }
  setRuntimeDependencies(actor: CommunityAccountActor, packageName: string, names: readonly string[]): CommunityPluginView {
    this.assertAdmin(actor); this.assertIdle(packageName); this.assertWritable(packageName)
    const row = this.required(packageName)
    if (row.removing || !Array.isArray(names) || names.some(name => typeof name !== 'string') || new Set(names).size !== names.length || !this.runtimeDependencies)
      throw new BusinessRuleError('invalid', 'Select existing runtime dependencies.', 'runtime-dependency-invalid')
    this.runtimeDependencies.ready(names)
    for (const setting of this.settings?.access.get?.(packageName)?.environment ?? []) assertPluginDependencyTemplate(setting.value, new Set(names))
    this.store.save({ ...row, runtimeDependencies: [...names] })
    return this.view(this.required(packageName))
  }
  setMaintainer(actor: CommunityAccountActor, packageName: string, username: string | null, revision: string): CommunityPluginView {
    this.assertAdmin(actor); this.assertIdle(packageName); this.assertWritable(packageName)
    const row = this.required(packageName)
    if (revision !== this.maintenanceRevision(row)) throw new BusinessRuleError('conflict', 'Review the changed plugin ownership.', 'plugin-impact-changed')
    const target = username === null ? undefined : this.accounts.get(username)
    if (username !== null && (!target || target.disabled)) throw new BusinessRuleError('invalid', 'Choose a current member.', 'contribution-invalid')
    this.store.save({ ...row, provenance: { anonymous: row.provenance?.anonymous ?? false, versions: row.provenance?.versions ?? [], maintainer: target ? { username: target.username, spaceId: target.spaceId } : null } })
    return this.view(this.required(packageName))
  }
  assertSuiteAdmission(origin: string, packageName: string): void {
    this.assertIdle(packageName)
    if (this.suiteClaims?.().some(row => row.packageName === packageName && row.origin !== origin)) throw new BusinessRuleError('conflict', 'Another catalog task holds this package.', 'plugin-job-busy')
    const row = this.store.list().find(row => row.packageName === packageName)
    if (row?.removing) throw new BusinessRuleError('conflict', 'Plugin removal is pending.', 'plugin-job-busy')
    if (row?.suiteOrigin && row.suiteOrigin !== origin) throw new BusinessRuleError('conflict', 'Another catalog owns this plugin.', 'plugin-name-in-use')
  }
  /** Suite catalog seams: one catalog origin at a time prepares and commits a plugin row under that origin. */
  suitePluginRow(origin: string): LibraryPlugin | undefined {
    const row = this.store.list().find(row => row.suiteOrigin === origin)
    return row ? structuredClone(row) : undefined
  }
  /** Same-package rows another catalog origin owns; they conflict with this entry. */
  suitePluginConflicts(origin: string, packageName: string): readonly string[] {
    const row = this.store.list().find(row => row.packageName === packageName)
    return row?.suiteOrigin && row.suiteOrigin !== origin || this.tasks.has(packageName) || this.suiteClaims?.().some(claim => claim.packageName === packageName && claim.origin !== origin) ? [packageName] : []
  }
  /** The manual row a confirmed catalog install takes over in place. */
  suitePluginReplaceable(packageName: string): { readonly row: LibraryPlugin, readonly revision: string } | undefined {
    const row = this.store.list().find(row => row.packageName === packageName && !row.suiteOrigin)
    return row ? { row: structuredClone(row), revision: pluginCatalogRevision(row, this.settings?.access.get?.(packageName)?.revision ?? 'none') } : undefined
  }
  suitePluginImpact(origin: string): { name: string, groups: readonly { id: string, name: string }[], published: boolean, selectedMembers: number } | undefined {
    const row = this.store.list().find(row => row.suiteOrigin === origin)
    if (!row) return undefined
    return { name: row.packageName, groups: this.membership?.impactGroups?.(row.packageName) ?? [], published: row.published, selectedMembers: this.membership?.impact(row.packageName).selectedMembers ?? 0 }
  }
  /** Prepares the locked package under a catalog origin; nothing is written until commitSuitePlugin. */
  async prepareSuitePlugin(origin: string, item: { readonly packageName: string, readonly version: string, readonly integrity: string }, log: (line: string) => Promise<void>, signal: AbortSignal): Promise<import('../domain/plugin-library.js').PreparedPlugin> {
    if (this.stopped) throw new BusinessRuleError('conflict', 'Plugin preparation is stopping.', 'plugin-job-interrupted')
    this.assertSuiteAdmission(origin, item.packageName)
    const holder = this.store.list().find(row => row.packageName === item.packageName)
    if (holder?.suiteOrigin && holder.suiteOrigin !== origin) throw new BusinessRuleError('conflict', 'This package is already in the library.', 'plugin-name-in-use')
    const known = holder ? this.identities(holder)[item.version] : undefined
    await log(`Preparing plugin ${item.packageName}@${item.version}…`)
    const candidate: PluginCandidate = { packageName: item.packageName, version: item.version }
    const prepared = await this.preparer.prepare(candidate, () => {}, signal)
    signal.throwIfAborted()
    this.assertSuiteAdmission(origin, item.packageName)
    assertPreparedPlugin(candidate, prepared, known)
    // The catalog lock decides the bytes: whatever npm serves must hash to the signed integrity.
    if (prepared.integrity !== item.integrity) throw new PluginPreparationError('plugin-integrity-invalid')
    this.suiteStaged.set(origin, prepared)
    return structuredClone(prepared)
  }
  /** Writes the plugin row in place, keeping publication, grants and settings that follow the package name; `takeover` is the confirmed manual row (or, on update, the row this origin already owns). */
  commitSuitePlugin(origin: string, item: { readonly packageName: string, readonly version: string, readonly integrity: string, readonly access: import('../domain/admin-contract.js').CommunityPluginAccessInput }, prepared: import('../domain/plugin-library.js').PreparedPlugin, runtimeDependencies: readonly string[], takeover?: LibraryPlugin): LibraryPlugin {
    this.assertSuiteAdmission(origin, item.packageName)
    const staged = this.suiteStaged.get(origin)
    if (!staged || staged.integrity !== prepared.integrity || staged.packageName !== item.packageName) throw new BusinessRuleError('conflict', 'This plugin was not prepared for this task.', 'suite-catalog-invalid')
    this.suiteStaged.delete(origin)
    const current = this.store.list().find(row => row.packageName === item.packageName)
    if (current && current.suiteOrigin !== origin) {
      // A row the plan did not confirm, or one that changed after the preview, refuses the takeover.
      if (!takeover || takeover.suiteOrigin || current.version !== takeover.version || current.current?.integrity !== takeover.current?.integrity)
        throw new BusinessRuleError('conflict', 'The manual plugin changed after the preview. Review the install again.', 'suite-replace-unconfirmed')
    }
    const provenance = current?.provenance ?? takeover?.provenance
    const { upload, replacement, failureCode, incompatible, restorePublication, retainedIntegrity, ...metadata } = current ?? {}
    void upload; void replacement; void failureCode; void incompatible; void restorePublication; void retainedIntegrity
    const row: LibraryPlugin = { ...metadata, packageName: item.packageName, version: item.version, runtimeDependencies: [...runtimeDependencies],
      suiteOrigin: origin, suiteAppliedAccess: pluginAccessIdentity(item.access),
      ...(provenance ? { provenance } : {}),
      current: prepared, stage: 'available', published: current?.published === true || current?.restorePublication === true,
      identities: { ...this.identities(current ?? takeover), [item.version]: item.integrity },
      ...(this.compatibilityTarget ? { checkedFor: this.compatibilityTarget } : {}) }
    this.store.save(row)
    return structuredClone(row)
  }
  /** Puts back the row a failed or interrupted task replaced, touching only rows this origin still owns. */
  restoreSuitePlugin(origin: string, snapshot: { readonly row: LibraryPlugin }): void {
    const current = this.store.list().find(row => row.packageName === snapshot.row.packageName)
    if (!current || current.suiteOrigin !== origin) return
    this.store.save(structuredClone(snapshot.row))
  }
  dropSuitePluginRow(origin: string, packageName: string): void {
    if (this.store.list().some(row => row.packageName === packageName && row.suiteOrigin === origin)) this.store.remove(packageName)
  }
  restoreSuiteAccessBaseline(origin: string, baseline?: string): void {
    const row = this.suitePluginRow(origin)
    if (row) this.store.save({ ...row, ...(baseline !== undefined ? { suiteAppliedAccess: baseline } : {}) })
  }
  discardSuitePlugin(origin: string): void { this.suiteStaged.delete(origin) }
  /** Removes the plugin rows this origin owns, with their grants, selections, access settings, checkpoints and upstreams. */
  removeSuitePlugin(origin: string): void {
    for (const row of this.store.list().filter(row => row.suiteOrigin === origin)) {
      this.membership?.revoke(row.packageName)
      this.settings?.access.remove(row.packageName)
      this.settings?.access.clearSuiteCheckpoint?.(row.packageName, origin)
      this.settings?.upstreams.save(row.packageName, [])
      this.store.remove(row.packageName)
    }
    this.suiteStaged.delete(origin)
  }
  /** Detaching keeps the plugin, its settings, grants and publication; only the catalog ownership goes. */
  detachSuitePlugin(origin: string, packageName: string): void {
    const row = this.store.list().find(row => row.packageName === packageName && row.suiteOrigin === origin)
    if (!row) return
    const { suiteOrigin, suiteAppliedAccess, ...detached } = row; void suiteOrigin; void suiteAppliedAccess
    this.store.save(detached)
  }
  private maintenanceRevision(row: LibraryPlugin) { return JSON.stringify([row.current?.integrity, row.provenance?.maintainer ?? null, row.provenance?.anonymous ?? false]) }
  private assertAdmin(actor: CommunityAccountActor): void {
    const current = this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
