import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityPluginView } from '../domain/admin-contract.js'
import { assertPluginIdentity, registryDependenciesAllowed, PluginPreparationError, type LibraryPlugin, type PluginIdentity, type UploadedPlugin } from '../domain/plugin-library.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort, PluginPreparerPort, PluginUploadPort } from '../ports/plugin-library.js'

/** Owns durable additions and their in-flight preparation, including shutdown. */
export class PluginLibrary {
  private readonly tasks = new Map<string, { controller: AbortController, completion: Promise<void> }>()
  private readonly intake = new Set<{ controller: AbortController, completion: Promise<CommunityPluginView> }>()
  private stopped = false
  private readonly taskFailures: unknown[] = []
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly store: PluginLibraryStorePort, private readonly preparer: PluginPreparerPort, private readonly uploads?: PluginUploadPort) {
    for (const row of store.list()) if (row.stage !== 'available' && row.stage !== 'failed')
      store.save({ ...row, stage: 'failed', failureCode: 'plugin-job-interrupted' })
  }
  async recover(): Promise<void> { await this.preparer.recover?.(); await this.uploads?.recover?.(this.store.list().flatMap(row => row.upload ? [row.upload.archive] : [])) }
  list(actor: CommunityAccountActor): readonly CommunityPluginView[] {
    this.assertAdmin(actor); return this.store.list().map(row => this.view(row))
  }
  add(actor: CommunityAccountActor, input: PluginIdentity, retry = false): CommunityPluginView {
    this.assertAdmin(actor); assertPluginIdentity(input)
    if (this.stopped) throw new BusinessRuleError('conflict', 'Plugin preparation is stopping.', 'plugin-job-interrupted')
    const existing = this.store.list().find(row => row.packageName === input.packageName)
    if (existing && existing.version !== input.version) throw new BusinessRuleError('conflict', 'This package is already in the library.', 'plugin-name-in-use')
    if (existing && (!retry || existing.stage !== 'failed' || this.tasks.has(input.packageName))) return this.view(existing)
    const row: LibraryPlugin = { ...input, ...(existing?.upload ? { upload: existing.upload } : {}), stage: 'resolving', current: null, published: false }
    return this.enqueue(row)
  }
  private enqueue(row: LibraryPlugin): CommunityPluginView {
    this.store.save(row)
    const controller = new AbortController()
    const completion = this.prepare(row, controller.signal)
    this.tasks.set(row.packageName, { controller, completion })
    void completion.then(() => this.tasks.delete(row.packageName), error => { this.taskFailures.push(error); this.tasks.delete(row.packageName) })
    return this.view(row)
  }
  async upload(actor: CommunityAccountActor, filename: string, content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<CommunityPluginView> {
    this.assertAdmin(actor)
    if (this.stopped) throw new BusinessRuleError('conflict', 'Plugin preparation is stopping.', 'plugin-job-interrupted')
    if (!this.uploads) throw new PluginPreparationError('plugin-runtime-required')
    const controller = new AbortController()
    const abort = () => controller.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort()
    const completion = this.receiveUpload(actor, filename, content, controller.signal)
    const intake = { controller, completion }; this.intake.add(intake)
    try { return await completion }
    finally { this.intake.delete(intake); signal.removeEventListener('abort', abort) }
  }
  private async receiveUpload(actor: CommunityAccountActor, filename: string, content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<CommunityPluginView> {
    let uploaded: UploadedPlugin | undefined
    let accepted = false
    try {
      uploaded = await this.uploads!.accept(filename, content, signal)
      signal.throwIfAborted(); this.assertAdmin(actor); assertPluginIdentity(uploaded)
      if (this.stopped) throw new PluginPreparationError('plugin-job-interrupted')
      const existing = this.store.list().find(row => row.packageName === uploaded!.packageName)
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
  private async prepare(row: LibraryPlugin, signal: AbortSignal): Promise<void> {
    try {
      const prepared = await this.preparer.prepare(row, stage => { signal.throwIfAborted(); this.store.save({ ...row, stage }) }, signal)
      signal.throwIfAborted()
      if (row.upload && prepared.integrity !== row.upload.integrity) throw new PluginPreparationError('plugin-integrity-invalid')
      if (!registryDependenciesAllowed(prepared)) throw new PluginPreparationError('plugin-dependency-invalid')
      if (prepared.packageName !== row.packageName || prepared.version !== row.version) throw new PluginPreparationError('plugin-package-invalid')
      this.store.save({ ...row, stage: 'available', current: prepared })
    } catch (error) {
      this.store.save({ ...row, stage: 'failed', failureCode: error instanceof PluginPreparationError && error.code === 'plugin-cleanup-failed' ? error.code
        : signal.aborted ? 'plugin-job-interrupted' : error instanceof PluginPreparationError ? error.code : 'plugin-precheck-failed' })
    }
  }
  private view(row: LibraryPlugin): CommunityPluginView {
    return { source: row.upload ? 'upload' : 'npm', packageName: row.packageName, version: row.version, currentVersion: row.current?.version ?? null,
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
