import type { McpService } from '../domain/mcp-service.js'
import { mcpDependency } from '../domain/mcp-dependency.js'
import type { McpPreparedRuntime, McpRuntimePort, McpStorePort } from '../ports/mcp-services.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'

/** MCP references the shared dependency library; service credentials never enter preparation. */
export class McpRuntimeDependencies implements McpRuntimePort {
  constructor(private readonly store: Pick<McpStorePort, 'read'>, private readonly dependencies: RuntimeDependencies,
    private readonly options: { legacy?: { version?(): number, ready(service: McpService): McpPreparedRuntime | undefined, collect(services: readonly McpService[]): Promise<void> }, running?: Pick<import('./mcp-shared-runtime.js').McpSharedRuntime, 'recover' | 'start' | 'reconcile' | 'stop'>, isolated?: () => boolean } = {}) {}
  version(): string | undefined {
    const dependencies = this.dependencies.version(), legacy = this.options.legacy ? this.options.legacy.version?.() : 0
    return dependencies === undefined || legacy === undefined ? undefined : `${dependencies}:${legacy}`
  }
  validateReferences(run: McpService['run'], previous?: McpService['run']): void {
    this.dependencies.ready((run?.runtimeDependencies ?? []).filter(name => !previous?.runtimeDependencies?.includes(name)))
  }
  configure(service: McpService): McpService {
    if (service.dependencyPromotion) {
      const { from, to } = service.dependencyPromotion
      this.dependencies.promoteManaged(from, to)
      const { dependencyPromotion, dependencyTarget, ...next } = service; void dependencyPromotion; void dependencyTarget
      return { ...next, dependencyName: to, run: { ...service.run!, runtimeDependencies: service.run!.runtimeDependencies!.map(name => name === from ? to : name) } }
    }
    if (!service.run || service.run.prepareCommand === undefined) return service
    const name = this.dependencies.registerManaged(`mcp:${service.preparationName ?? `${service.name}:${service.generation}`}`, mcpDependency(service), service.catalog ? 'mcp-catalog' : 'manual', service.dependencyTarget, service.preparationName?.startsWith('catalog-update:') ?? false)
    const { prepareCommand, ...run } = service.run; void prepareCommand
    return { ...service, dependencyName: name, run: { ...run, runtimeDependencies: [...new Set([name, ...run.runtimeDependencies ?? []])] } }
  }
  promote(candidate: McpService, previous: McpService): McpService {
    return candidate.dependencyName && candidate.dependencyName !== previous.dependencyName
      ? { ...candidate, dependencyPromotion: { from: candidate.dependencyName, to: previous.dependencyName ?? candidate.dependencyName } } : candidate
  }
  ready(service: McpService) {
    if (!service.run || service.run.prepareCommand !== undefined) return undefined
    try {
      const versions = this.dependencies.ready(service.run.runtimeDependencies ?? [], true)
      const own = service.dependencyName ? versions[(service.run.runtimeDependencies ?? []).indexOf(service.dependencyName)] : undefined
      return { directory: (own ?? versions[0])?.mountedPath ?? '/tmp', dependencies: versions }
    } catch { return this.options.legacy?.ready(service) }
  }
  view(service: McpService) {
    if (!service.run) return undefined
    const states = (service.run.runtimeDependencies ?? []).map(name => this.dependencies.state(name))
    return { ...(this.ready(service)?.legacy ? { usingPrevious: true } : {}), ...(service.run.location === 'shared' ? { isolated: this.options.isolated?.() ?? false } : {}), stage: states.some(row => row.stage === 'failed') ? 'failed' as const : states.some(row => row.stage !== 'ready') ? 'preparing' as const : 'ready' as const,
      updatedAt: Math.max(0, ...states.map(row => row.updatedAt)), log: states.map(row => row.log).filter(Boolean).join('\n') }
  }
  private services(): readonly McpService[] { return this.store.read().services.flatMap(row => [row, ...row.catalogUpdate?.candidate ? [row.catalogUpdate.candidate] : []]) }
  async changed(): Promise<void> {
    await this.options.running?.reconcile()
    await this.options.legacy?.collect(this.services().filter(service => this.ready(service)?.legacy || this.dependencies.preparing(service.run?.runtimeDependencies ?? [])))
    await this.dependencies.collectManagedCandidates()
  }
  async recover(): Promise<void> { await this.options.running?.recover() }
  start(): void { this.options.running?.start() }
  async stop(): Promise<void> { await this.options.running?.stop() }
  restart(name: string): void { const service = this.store.read().services.find(row => row.name === name); for (const dependency of service?.run?.runtimeDependencies ?? []) void this.dependencies.restartManaged(dependency) }
}
