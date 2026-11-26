import { completeAdministratorPluginSource } from '../domain/library-contribution.js'
import {
  assertPreparedPlugin,
  PluginPreparationError,
  type PluginReplacement,
  withSourceCommit,
  type LibraryPlugin,
  type PluginCandidate,
  type PreparedPlugin,
} from '../domain/plugin-library.js'
import type { PluginLibraryStorePort, PluginPreparerPort } from '../ports/plugin-library.js'

/** Startup gate: no member can load or download a plugin before upgrade checks finish. */
export class PluginCompatibility {
  private readonly controller = new AbortController()
  private task: Promise<void> | undefined
  recover(): Promise<void> {
    this.controller.signal.throwIfAborted()
    return (this.task ??= this.run())
  }
  async stop(): Promise<void> {
    this.controller.abort()
    try {
      await this.task
    } catch (error) {
      if (error !== this.controller.signal.reason) throw error
    }
  }
  constructor(
    private readonly store: PluginLibraryStorePort,
    private readonly preparer: PluginPreparerPort,
    private readonly target: string,
    private readonly verifiedPredecessors: readonly string[] = [],
  ) {}
  private async run(): Promise<void> {
    for (const original of await this.store.list()) {
      this.controller.signal.throwIfAborted()
      if (original.removing || original.checkedFor === this.target) continue
      if (this.canReuseCurrent(original)) {
        const replacement = original.replacement
        const requiresCheck = replacement?.stage === 'available' && replacement.prepared?.runtimeRevision !== this.target.split('/').at(-1)
        await this.store.save({
          ...original,
          ...(requiresCheck ? { replacement: await this.checkReplacement(replacement, original.identities) } : {}),
          checkedFor: this.target,
        })
        continue
      }
      const row = { ...original }
      delete row.failureCode
      // Save intent before asynchronous work. An interrupted check is repeated on startup.
      let next: LibraryPlugin = {
        ...row,
        identities: {
          ...row.identities,
          ...(row.current ? { [row.version]: row.current.integrity } : {}),
          ...(row.replacement?.prepared ? { [row.replacement.version]: row.replacement.prepared.integrity } : {}),
        },
        stage: 'prechecking',
        published: false,
        restorePublication: row.published || row.restorePublication === true,
      }
      await this.store.save(next)
      next = (await this.store.list()).find(value => value.packageName === row.packageName)!
      try {
        const current = withSourceCommit(await this.check(row, row.current, row.current?.integrity ?? next.identities?.[row.version]), row.current)
        next = { ...next, current, stage: 'available', incompatible: false, published: next.restorePublication === true, restorePublication: false }
      } catch (error) {
        this.rethrowFatal(error)
        next = { ...next, stage: 'failed', incompatible: true, failureCode: 'plugin-incompatible' }
      }
      if (row.replacement) {
        next = { ...next, replacement: await this.checkReplacement(row.replacement, next.identities) }
      }
      await this.store.save(completeAdministratorPluginSource({ ...next, checkedFor: this.target }))
    }
  }
  private canReuseCurrent(row: LibraryPlugin): boolean {
    return (
      row.checkedFor !== undefined &&
      this.verifiedPredecessors.includes(row.checkedFor) &&
      row.stage === 'available' &&
      !row.incompatible &&
      row.current?.runtimeRevision === this.target.split('/').at(-1)
    )
  }
  private async checkReplacement(replacement: PluginReplacement, identities: LibraryPlugin['identities']): Promise<PluginReplacement> {
    try {
      const { prepared, version, upload } = replacement
      const checked = withSourceCommit(await this.check(replacement, prepared, prepared?.integrity ?? identities?.[version]), prepared)
      return { packageName: checked.packageName, version: checked.version, ...(upload ? { upload } : {}), stage: 'available', prepared: checked }
    } catch (error) {
      this.rethrowFatal(error)
      return { ...replacement, stage: 'failed', prepared: null, failureCode: 'plugin-incompatible' }
    }
  }
  private rethrowFatal(error: unknown): void {
    if (error instanceof PluginPreparationError && error.code === 'plugin-cleanup-failed') throw error
    this.controller.signal.throwIfAborted()
  }
  private async check(input: PluginCandidate, retained: PreparedPlugin | null, knownIntegrity?: string): Promise<PreparedPlugin> {
    const candidate = {
      packageName: input.packageName,
      version: input.version,
      ...(input.upload ? { upload: input.upload } : {}),
      ...(retained ? { retainedIntegrity: retained.integrity } : {}),
      ...(retained?.installDefaults ? { installDefaults: retained.installDefaults } : {}),
    }
    const prepared = await this.preparer.prepare(candidate, async () => {}, this.controller.signal)
    this.controller.signal.throwIfAborted()
    assertPreparedPlugin(candidate, prepared, knownIntegrity ?? retained?.integrity)
    return retained?.catalogArchiveUrl ? { ...prepared, catalogArchiveUrl: retained.catalogArchiveUrl } : prepared
  }
}
