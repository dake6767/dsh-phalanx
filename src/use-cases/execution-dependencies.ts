import { ExecutionFailure, executionPreparationApproved } from '../domain/platform-execution.js'
import type { ExecutionConfigurationStorePort, ExecutionMaterial, ExecutionOwnerInventoryPort } from '../ports/platform-execution.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'

/** Retains current skill sources and declared dependency versions for admitted calls. */
export class ExecutionDependencies {
  private readonly sources = new Map<string, number>()
  private readonly calls = new Set<Promise<unknown>>()
  private stopped = false
  constructor(
    private readonly owners: ExecutionOwnerInventoryPort,
    private readonly configurations: ExecutionConfigurationStorePort,
    private readonly dependencies: Pick<RuntimeDependencies, 'state' | 'ready' | 'withPrepared'>,
  ) {}
  sourceVersions(): readonly string[] {
    return [...this.sources.keys()]
  }
  async recover(): Promise<void> {
    await this.changed()
  }
  async view(owner: string) {
    const configuration = await this.configurations.get(owner),
      source = this.owners.get(owner)
    if (!configuration || !source) return undefined
    const states = (configuration.runtimeDependencies ?? []).map(name => this.dependencies.state(name))
    const usable = this.available(configuration)
    const failure = states.find(row => row.stage === 'failed'),
      pending = states.find(row => row.stage !== 'ready')
    return {
      identity: source.version,
      usable,
      stage: failure ? ('failed' as const) : pending ? ('preparing' as const) : ('ready' as const),
      updatedAt: Math.max(0, ...states.map(row => row.updatedAt)),
      log: states
        .map(row => row.log)
        .filter(Boolean)
        .join('\n'),
    }
  }
  async changed(): Promise<void> {
    const configurations = await this.configurations.list()
    const owners = this.owners.identities()
    for (const row of configurations) if (!owners.includes(row.owner)) await this.configurations.remove(row.owner, row.configuration.rowRevision)
  }
  withPrepared<T>(owner: string, run: (material: ExecutionMaterial) => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new ExecutionFailure('internal'))
    const task = this.usePrepared(owner, run)
    this.calls.add(task)
    return task.finally(() => {
      this.calls.delete(task)
    })
  }
  private async usePrepared<T>(owner: string, run: (material: ExecutionMaterial) => Promise<T>): Promise<T> {
    const configuration = await this.configurations.get(owner),
      source = this.owners.get(owner)
    if (!source || !configuration || !executionPreparationApproved(source, configuration)) throw new ExecutionFailure('not-ready')
    this.sources.set(source.version, (this.sources.get(source.version) ?? 0) + 1)
    try {
      return await this.dependencies.withPrepared(configuration.runtimeDependencies ?? [], versions => run({ version: source.version, dependencies: versions }))
    } finally {
      const remaining = this.sources.get(source.version)! - 1
      if (remaining) this.sources.set(source.version, remaining)
      else this.sources.delete(source.version)
      await this.changed()
    }
  }
  async stop(): Promise<void> {
    this.stopped = true
    await Promise.allSettled(this.calls)
  }
  private available(configuration: Awaited<ReturnType<ExecutionConfigurationStorePort['get']>>): boolean {
    if (!configuration) return false
    try {
      this.dependencies.ready(configuration.runtimeDependencies ?? [])
      return true
    } catch {
      return false
    }
  }
}
