import type { ExecutionPreparationStorePort } from '../ports/execution-preparation.js'
import type { ExecutionConfigurationStorePort, ExecutionMaterial, ExecutionOwnerInventoryPort } from '../ports/platform-execution.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import { ExecutionFailure, executionPreparationApproved } from '../domain/platform-execution.js'

interface LegacyArtifacts {
  pathDirectories(id?: string): Promise<readonly string[]>
  collect(retained: readonly string[]): Promise<void>
}

/** Execution consumes shared dependencies; old private artifacts exist only as migration fallbacks. */
export class ExecutionDependencies {
  private readonly leases = new Map<string, number>()
  private readonly sources = new Map<string, number>()
  private readonly calls = new Set<Promise<unknown>>()
  private collection: Promise<void> = Promise.resolve()
  private stopped = false
  constructor(private readonly owners: ExecutionOwnerInventoryPort, private readonly configurations: ExecutionConfigurationStorePort,
    private readonly legacy: ExecutionPreparationStorePort, private readonly artifacts: LegacyArtifacts,
    private readonly dependencies: Pick<RuntimeDependencies, 'migrate' | 'state' | 'ready' | 'withPrepared' | 'updateSource'>) {}
  sourceVersions(): readonly string[] { return [...this.sources.keys()] }
  async recover(): Promise<void> { await this.changed() }
  private async migrateApproved(): Promise<void> {
    for (const { owner, configuration } of this.configurations.list()) if (configuration.prepare) {
      const source = this.owners.get(owner)
      if (!source || !executionPreparationApproved(source, configuration)) continue
      const pathDirectories = await this.artifacts.pathDirectories(this.legacy.get(owner)?.artifact?.id)
      const latest = this.configurations.get(owner), currentSource = this.owners.get(owner)
      if (!latest?.prepare || !currentSource || !executionPreparationApproved(currentSource, latest)) continue
      const name = this.dependencies.migrate(owner, { name: `execution-${owner.replace(/[^\p{L}\p{N}._-]/gu, '-')}`.slice(0, 90), prepareCommand: latest.prepare,
        pathDirectories }, currentSource.version)
      const { prepare, ...next } = latest; void prepare
      this.configurations.save(owner, { ...next, runtimeDependencies: [...new Set([...(next.runtimeDependencies ?? []), name])] })
    }
  }
  view(owner: string) {
    const configuration = this.configurations.get(owner), source = this.owners.get(owner)
    if (!configuration || !source) return undefined
    const states = (configuration.runtimeDependencies ?? []).map(name => this.dependencies.state(name))
    const usable = this.available(owner)
    const failure = states.find(row => row.stage === 'failed'), pending = states.find(row => row.stage !== 'ready')
    return { identity: source.version, usable: usable || !!this.legacy.get(owner)?.artifact, stage: failure ? 'failed' as const : pending ? 'preparing' as const : 'ready' as const,
      updatedAt: Math.max(0, ...states.map(row => row.updatedAt)), log: states.map(row => row.log).filter(Boolean).join('\n'),
      ...(!usable && this.legacy.get(owner)?.artifact ? { usingPrevious: true } : {}) }
  }
  async changed(): Promise<void> {
    this.configurations.retain(this.owners.identities())
    await this.migrateApproved()
    for (const { owner, configuration } of this.configurations.list()) {
      const source = this.owners.get(owner)
      if (source && executionPreparationApproved(source, configuration) && configuration.runtimeDependencies?.some(name => this.dependencies.state(name).migrationOrigin === owner)) this.dependencies.updateSource(owner, source.version)
    }
    // Successful migration removes legacy metadata; leases keep already admitted calls alive.
    this.legacy.retain(this.owners.identities().filter(owner => !this.available(owner)))
    await this.collect()
  }
  async withPrepared<T>(owner: string, run: (material: ExecutionMaterial) => Promise<T>): Promise<T> {
    if (this.stopped) throw new ExecutionFailure('internal')
    const source = this.owners.get(owner), configuration = this.configurations.get(owner)
    if (!source || !configuration || !executionPreparationApproved(source, configuration)) throw new ExecutionFailure('not-ready')
    this.sources.set(source.version, (this.sources.get(source.version) ?? 0) + 1)
    const execute = async () => {
      if (this.available(owner)) return this.dependencies.withPrepared(configuration.runtimeDependencies ?? [], versions => {
        const index = (configuration.runtimeDependencies ?? []).findIndex(name => this.dependencies.state(name).migrationOrigin === owner)
        return run({ version: source.version, dependencies: versions, ...(index >= 0 ? { sourceDependency: versions[index]! } : {}) })
      })
      const artifact = this.legacy.get(owner)?.artifact
      if (!artifact) throw new ExecutionFailure('not-ready')
      this.leases.set(artifact.id, (this.leases.get(artifact.id) ?? 0) + 1)
      try { return await run(artifact) }
      finally { const remaining = this.leases.get(artifact.id)! - 1; if (remaining) this.leases.set(artifact.id, remaining); else this.leases.delete(artifact.id) }
    }
    const task = execute(); this.calls.add(task)
    try { return await task } finally { this.calls.delete(task); const remaining = this.sources.get(source.version)! - 1; if (remaining) this.sources.set(source.version, remaining); else this.sources.delete(source.version); await this.changed() }
  }
  async stop(): Promise<void> { this.stopped = true; await Promise.allSettled(this.calls); await this.collection }
  private available(owner: string): boolean {
    const configuration = this.configurations.get(owner)
    if (!configuration || configuration.prepare) return false
    try { this.dependencies.ready(configuration.runtimeDependencies ?? []); return true } catch { return false }
  }
  private collect(): Promise<void> {
    const next = this.collection.then(() => this.artifacts.collect([...this.legacy.list().flatMap(row => row.artifact ? [row.artifact.id] : []), ...this.leases.keys()]))
    this.collection = next.catch(() => {}); return next
  }
}
