import type { CommunityAccountActor } from '../domain/community-account.js'
import { CommunityAuthenticationError } from '../domain/community-account.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { CommunityPluginView } from '../domain/admin-contract.js'
import { assertPluginIdentity, registryDependenciesAllowed, PluginPreparationError, type LibraryPlugin, type PluginIdentity } from '../domain/plugin-library.js'
import type { CommunityAccountStorePort } from '../ports/community-accounts.js'
import type { PluginLibraryStorePort, PluginPreparerPort } from '../ports/plugin-library.js'

/** Owns durable additions and their in-flight preparation, including shutdown. */
export class PluginLibrary {
  private readonly tasks = new Map<string, { controller: AbortController, completion: Promise<void> }>()
  private stopped = false
  private readonly taskFailures: unknown[] = []
  constructor(private readonly accounts: Pick<CommunityAccountStorePort, 'get'>,
    private readonly store: PluginLibraryStorePort, private readonly preparer: PluginPreparerPort) {
    for (const row of store.list()) if (row.stage !== 'available' && row.stage !== 'failed')
      store.save({ ...row, stage: 'failed', failureCode: 'plugin-job-interrupted' })
  }
  async recover(): Promise<void> { await this.preparer.recover?.() }
  list(actor: CommunityAccountActor): readonly CommunityPluginView[] {
    this.assertAdmin(actor); return this.store.list().map(row => this.view(row))
  }
  add(actor: CommunityAccountActor, input: PluginIdentity, retry = false): CommunityPluginView {
    this.assertAdmin(actor); assertPluginIdentity(input)
    if (this.stopped) throw new BusinessRuleError('conflict', 'Plugin preparation is stopping.', 'plugin-job-interrupted')
    const existing = this.store.list().find(row => row.packageName === input.packageName)
    if (existing && existing.version !== input.version) throw new BusinessRuleError('conflict', 'This package is already in the library.', 'plugin-name-in-use')
    if (existing && (!retry || existing.stage !== 'failed' || this.tasks.has(input.packageName))) return this.view(existing)
    const row: LibraryPlugin = { ...input, stage: 'resolving', current: null, published: false }
    this.store.save(row)
    const controller = new AbortController()
    const completion = this.prepare(row, controller.signal)
    this.tasks.set(input.packageName, { controller, completion })
    void completion.then(() => this.tasks.delete(input.packageName), error => { this.taskFailures.push(error); this.tasks.delete(input.packageName) })
    return this.view(row)
  }
  async drain(): Promise<void> {
    const results = await Promise.allSettled([...this.tasks.values()].map(task => task.completion))
    const failures = [...new Set([...this.taskFailures, ...results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])])]
    if (failures.length) throw new AggregateError(failures, 'Plugin preparation tasks failed')
  }
  async stop(): Promise<void> {
    this.stopped = true
    for (const task of this.tasks.values()) task.controller.abort()
    await this.drain()
  }
  private async prepare(row: LibraryPlugin, signal: AbortSignal): Promise<void> {
    try {
      const prepared = await this.preparer.prepare(row, stage => { signal.throwIfAborted(); this.store.save({ ...row, stage }) }, signal)
      signal.throwIfAborted()
      if (!registryDependenciesAllowed(prepared)) throw new PluginPreparationError('plugin-dependency-invalid')
      if (prepared.packageName !== row.packageName || prepared.version !== row.version) throw new PluginPreparationError('plugin-package-invalid')
      this.store.save({ ...row, stage: 'available', current: prepared })
    } catch (error) {
      this.store.save({ ...row, stage: 'failed', failureCode: error instanceof PluginPreparationError && error.code === 'plugin-cleanup-failed' ? error.code
        : signal.aborted ? 'plugin-job-interrupted' : error instanceof PluginPreparationError ? error.code : 'plugin-precheck-failed' })
    }
  }
  private view(row: LibraryPlugin): CommunityPluginView {
    return { packageName: row.packageName, version: row.version, currentVersion: row.current?.version ?? null,
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
