import { assertPreparedPlugin, PluginPreparationError, type LibraryPlugin, type PluginCandidate, type PreparedPlugin } from '../domain/plugin-library.js'
import type { PluginLibraryStorePort, PluginPreparerPort } from '../ports/plugin-library.js'

/** Startup gate: no member can load or download a plugin before upgrade checks finish. */
export class PluginCompatibility {
  private readonly controller = new AbortController()
  private task: Promise<void> | undefined
  recover(): Promise<void> {
    this.controller.signal.throwIfAborted()
    return this.task ??= this.run()
  }
  async stop(): Promise<void> {
    this.controller.abort()
    try { await this.task } catch (error) {
      if (error !== this.controller.signal.reason) throw error
    }
  }
  constructor(private readonly store: PluginLibraryStorePort, private readonly preparer: PluginPreparerPort, private readonly target: string) {}
  private async run(): Promise<void> {
    for (const original of this.store.list()) {
      this.controller.signal.throwIfAborted()
      if (original.removing || original.checkedFor === this.target) continue
      const row = { ...original }; delete row.failureCode
      // Save intent before asynchronous work. An interrupted check is repeated on startup.
      let next: LibraryPlugin = { ...row, identities: { ...row.identities, ...(row.current ? { [row.version]: row.current.integrity } : {}), ...(row.replacement?.prepared ? { [row.replacement.version]: row.replacement.prepared.integrity } : {}) }, stage: 'prechecking', published: false, restorePublication: row.published || row.restorePublication === true }
      this.store.save(next)
      try {
        const current = await this.check(row, row.current, next.identities?.[row.version])
        next = { ...next, current, stage: 'available', incompatible: false, published: next.restorePublication === true, restorePublication: false }
      } catch (error) {
        this.rethrowFatal(error)
        next = { ...next, stage: 'failed', incompatible: true, failureCode: 'plugin-incompatible' }
      }
      if (row.replacement) {
        try {
          const prepared = await this.check(row.replacement, row.replacement.prepared, next.identities?.[row.replacement.version])
          next = { ...next, replacement: { packageName: prepared.packageName, version: prepared.version, ...(row.replacement.upload ? { upload: row.replacement.upload } : {}), stage: 'available', prepared } }
        } catch (error) {
        this.rethrowFatal(error)
          next = { ...next, replacement: { ...row.replacement, stage: 'failed', prepared: null, failureCode: 'plugin-incompatible' } }
        }
      }
      this.store.save({ ...next, checkedFor: this.target })
    }
  }
  private rethrowFatal(error: unknown): void {
    if (error instanceof PluginPreparationError && error.code === 'plugin-cleanup-failed') throw error
    this.controller.signal.throwIfAborted()
  }
  private async check(input: PluginCandidate, retained: PreparedPlugin | null, knownIntegrity?: string): Promise<PreparedPlugin> {
    const candidate = { packageName: input.packageName, version: input.version, ...(input.upload ? { upload: input.upload } : {}), ...(retained ? { retainedIntegrity: retained.integrity } : {}) }
    const prepared = await this.preparer.prepare(candidate, () => {}, this.controller.signal)
    this.controller.signal.throwIfAborted()
    assertPreparedPlugin(candidate, prepared, knownIntegrity ?? retained?.integrity)
    return prepared
  }
}
