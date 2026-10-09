import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityPluginView, CommunityPluginImpact } from '../domain/admin-contract.js'
import { assertPluginIdentity, registryDependenciesAllowed, PluginPreparationError, type LibraryPlugin, type PluginIdentity, type UploadedPlugin, type PluginCandidate } from '../domain/plugin-library.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort, PluginPreparerPort, PluginUploadPort, PluginLibraryMembershipPort } from '../ports/plugin-library.js'

/** Owns durable additions and their in-flight preparation, including shutdown. */
export class PluginLibrary {
  private readonly tasks = new Map<string, { controller: AbortController, completion: Promise<void> }>()
  private readonly intake = new Set<{ controller: AbortController, completion: Promise<CommunityPluginView> }>()
  private stopped = false
  private readonly taskFailures: unknown[] = []
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly store: PluginLibraryStorePort, private readonly preparer: PluginPreparerPort, private readonly uploads?: PluginUploadPort, private readonly membership?: PluginLibraryMembershipPort) {
    for (const row of store.list()) if (row.stage !== 'available' && row.stage !== 'failed')
      store.save({ ...row, stage: 'failed', failureCode: 'plugin-job-interrupted' })
    for (const row of store.list()) if (row.replacement && !['available', 'failed'].includes(row.replacement.stage))
      store.save({ ...row, replacement: { ...row.replacement, stage: 'failed', failureCode: 'plugin-job-interrupted' } })
  }
  async recover(): Promise<void> {
    await this.preparer.recover?.()
    for (const row of this.store.list()) if (row.removing) this.finishRemoval(row.packageName)
    await this.uploads?.recover?.(this.store.list().flatMap(row => [row.upload?.archive, row.replacement?.upload?.archive].filter((path): path is string => path !== undefined)))
  }
  list(actor: CommunityAccountActor): readonly CommunityPluginView[] {
    this.assertAdmin(actor); return this.store.list().map(row => this.view(row))
  }
  add(actor: CommunityAccountActor, input: PluginIdentity, retry = false): CommunityPluginView {
    this.assertAdmin(actor); assertPluginIdentity(input)
    if (this.stopped) throw new BusinessRuleError('conflict', 'Plugin preparation is stopping.', 'plugin-job-interrupted')
    const existing = this.store.list().find(row => row.packageName === input.packageName)
    if (existing?.removing) throw new BusinessRuleError('conflict', 'Plugin removal is pending.', 'plugin-job-busy')
    if (existing && existing.version !== input.version) throw new BusinessRuleError('conflict', 'This package is already in the library.', 'plugin-name-in-use')
    if (existing && (!retry || existing.stage !== 'failed' || this.tasks.has(input.packageName))) return this.view(existing)
    const row: LibraryPlugin = { ...input, ...(existing ? { identities: this.identities(existing), ...(existing.replacement ? { replacement: existing.replacement } : {}) } : {}), ...(existing?.upload ? { upload: existing.upload } : {}), stage: 'resolving', current: null, published: false }
    return this.enqueue(row)
  }
  impact(actor: CommunityAccountActor, packageName: string): CommunityPluginImpact {
    this.assertAdmin(actor)
    const row = this.required(packageName)
    if (!this.membership) throw new BusinessRuleError('invalid', 'Plugin changes are unavailable.', 'plugin-action-invalid')
    const impact = this.membership.impact(packageName)
    return { ...impact, revision: JSON.stringify([row.version, row.current?.integrity, row.replacement?.prepared?.integrity, row.removing, impact]) }
  }
  replace(actor: CommunityAccountActor, input: PluginIdentity): CommunityPluginView {
    this.assertAdmin(actor); assertPluginIdentity(input); this.assertIdle(input.packageName)
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
    this.assertIdle(packageName); this.confirm(actor, packageName, revision)
    const next: LibraryPlugin = { packageName, version: replacement.version, ...(replacement.upload ? { upload: replacement.upload } : {}),
      current: replacement.prepared, stage: 'available', published: row.published, identities: this.identities(row) }
    this.store.save(next); return this.view(next)
  }
  remove(actor: CommunityAccountActor, packageName: string, revision: string): void {
    this.assertAdmin(actor); this.assertIdle(packageName); this.confirm(actor, packageName, revision)
    this.store.save({ ...this.required(packageName), removing: true, published: false })
    this.finishRemoval(packageName)
  }
  private finishRemoval(packageName: string): void {
    if (!this.membership) throw new Error('Plugin membership is required for removal recovery')
    this.membership.revoke(packageName)
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
  private track(packageName: string, run: (signal: AbortSignal) => Promise<void>): void {
    const controller = new AbortController()
    const completion = run(controller.signal)
    this.tasks.set(packageName, { controller, completion })
    void completion.then(() => this.tasks.delete(packageName), error => { this.taskFailures.push(error); this.tasks.delete(packageName) })
  }
  private enqueue(row: LibraryPlugin): CommunityPluginView {
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
      const result = this.enqueue({ packageName: uploaded.packageName, version: uploaded.version, upload: { archive: uploaded.archive, integrity: uploaded.integrity }, stage: 'resolving', current: null, published: false })
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
  private async prepare(row: LibraryPlugin, signal: AbortSignal, persist: (row: LibraryPlugin) => void = value => this.store.save(value)): Promise<void> {
    try {
      const prepared = await this.preparer.prepare(row, stage => { signal.throwIfAborted(); persist({ ...row, stage }) }, signal)
      signal.throwIfAborted()
      if (row.upload && prepared.integrity !== row.upload.integrity) throw new PluginPreparationError('plugin-integrity-invalid')
      const known = this.identities(this.required(row.packageName))[prepared.version]
      if (known !== undefined && known !== prepared.integrity) throw new PluginPreparationError('plugin-version-conflict')
      if (!registryDependenciesAllowed(prepared)) throw new PluginPreparationError('plugin-dependency-invalid')
      if (prepared.packageName !== row.packageName || prepared.version !== row.version) throw new PluginPreparationError('plugin-package-invalid')
      persist({ ...row, stage: 'available', current: prepared })
    } catch (error) {
      persist({ ...row, stage: 'failed', failureCode: error instanceof PluginPreparationError && error.code === 'plugin-cleanup-failed' ? error.code
        : signal.aborted ? 'plugin-job-interrupted' : error instanceof PluginPreparationError ? error.code : 'plugin-precheck-failed' })
    }
  }
  private identities(row: LibraryPlugin): Readonly<Record<string, string>> {
    return { ...row.identities, ...(row.upload ? { [row.version]: row.upload.integrity } : {}), ...(row.current ? { [row.current.version]: row.current.integrity } : {}),
      ...(row.replacement?.upload ? { [row.replacement.version]: row.replacement.upload.integrity } : {}), ...(row.replacement?.prepared ? { [row.replacement.version]: row.replacement.prepared.integrity } : {}) }
  }
  private view(row: LibraryPlugin): CommunityPluginView {
    return { ...(row.removing ? { removing: true } : {}), ...(row.replacement ? { replacement: { version: row.replacement.version, stage: row.replacement.stage, ...(row.replacement.failureCode ? { failureCode: row.replacement.failureCode } : {}) } } : {}), source: row.upload ? 'upload' : 'npm', packageName: row.packageName, version: row.version, currentVersion: row.current?.version ?? null,
      title: row.current?.title ?? row.packageName, description: row.current?.description ?? '', stage: row.stage,
      published: row.published, ...(row.current ? { integrity: row.current.integrity } : {}), ...(row.failureCode ? { failureCode: row.failureCode } : {}) }
  }
  private assertAdmin(actor: CommunityAccountActor): void {
    const current = this.accounts.get(actor.username)
    if (!current || current.disabled || current.spaceId !== actor.spaceId || current.sessionEpoch !== actor.sessionEpoch)
      throw new CommunityAuthenticationError('Sign in is required', 'sign-in-required')
    if (!current.admin) throw new BusinessRuleError('forbidden', 'Administrator access is required', 'admin-required')
  }
}
