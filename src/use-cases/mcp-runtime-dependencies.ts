import { BusinessRuleError } from '../domain/business-error.js'
import { mcpDependency } from '../domain/mcp-dependency.js'
import { validateMcpSettings, type McpService } from '../domain/mcp-service.js'
import type { McpRuntimePort, McpStatePort } from '../ports/mcp-services.js'
import type { RuntimeDependencyStorePort } from '../ports/runtime-dependencies.js'
import type { RuntimeDependencies } from './runtime-dependencies.js'
import type { RuntimeDependencyManaged } from './runtime-dependency-managed.js'

/** MCP references the shared dependency library; service credentials never enter preparation. */
export class McpRuntimeDependencies implements McpRuntimePort {
  constructor(
    private readonly store: Pick<McpStatePort, 'view'>,
    private readonly dependencies: RuntimeDependencies,
    private readonly options: {
      running?: Pick<import('./mcp-shared-runtime.js').McpSharedRuntime, 'recover' | 'start' | 'reconcile' | 'stop'>
      isolated?: () => boolean
    } = {},
  ) {}
  version(): string | undefined {
    return this.dependencies.version()
  }
  preparationSnapshot(): string | undefined {
    const dependencies = this.dependencies.version()
    if (dependencies === undefined) return undefined
    return JSON.stringify([dependencies, this.services().map(service => [this.ready(service), this.view(service)])])
  }
  async validateReferences(run: McpService['run'], previous?: McpService['run']): Promise<void> {
    await this.dependencies.readReady((run?.runtimeDependencies ?? []).filter(name => !previous?.runtimeDependencies?.includes(name)))
  }
  transaction(rows: RuntimeDependencyStorePort) {
    const scope = this.dependencies.transaction(rows)
    return { configure: (service: McpService) => this.configureWith(service, scope.mutations), committed: scope.committed }
  }
  configure(service: McpService): Promise<McpService> {
    return this.configureWith(service, this.dependencies)
  }
  private async configureWith(service: McpService, mutations: Pick<RuntimeDependencyManaged, 'registerManaged' | 'promoteManaged'>): Promise<McpService> {
    if (service.configurationRequired) return service
    validateMcpSettings(service)
    if (service.dependencyPromotion) {
      const { from, to } = service.dependencyPromotion
      await mutations.promoteManaged(from, to)
      const { dependencyPromotion, dependencyTarget, ...next } = service
      void dependencyPromotion
      void dependencyTarget
      return {
        ...next,
        dependencyName: to,
        run: { ...service.run!, runtimeDependencies: service.run!.runtimeDependencies!.map(name => (name === from ? to : name)) },
      }
    }
    if (!service.run || service.run.prepareCommand === undefined) return service
    const name = await mutations.registerManaged(
      `mcp:${service.preparationName ?? `${service.name}:${service.generation}`}`,
      mcpDependency(service),
      service.catalog ? 'mcp-catalog' : 'manual',
      service.dependencyTarget,
      service.preparationName?.startsWith('catalog-update:') ?? false,
    )
    const { prepareCommand, ...run } = service.run
    void prepareCommand
    return { ...service, dependencyName: name, run: { ...run, runtimeDependencies: [...new Set([name, ...(run.runtimeDependencies ?? [])])] } }
  }
  promote(candidate: McpService, previous: McpService): McpService {
    return candidate.dependencyName && candidate.dependencyName !== previous.dependencyName
      ? { ...candidate, dependencyPromotion: { from: candidate.dependencyName, to: previous.dependencyName ?? candidate.dependencyName } }
      : candidate
  }
  ready(service: McpService) {
    if (service.configurationRequired) return undefined
    if (!service.run || service.run.prepareCommand !== undefined) return undefined
    try {
      const versions = this.dependencies.ready(service.run.runtimeDependencies ?? [], true)
      const own = service.dependencyName ? versions[(service.run.runtimeDependencies ?? []).indexOf(service.dependencyName)] : undefined
      return { directory: (own ?? versions[0])?.mountedPath ?? '/tmp', dependencies: versions }
    } catch (error) {
      if (!(error instanceof BusinessRuleError) || error.code !== 'runtime-dependency-unavailable') throw error
      return undefined
    }
  }
  view(service: McpService) {
    if (service.configurationRequired) return { stage: 'failed' as const, updatedAt: 0, log: 'Reconfigure this service after the platform secret reset.' }
    if (!service.run) return undefined
    const states = (service.run.runtimeDependencies ?? []).map(name => this.dependencies.state(name))
    return this.status(service, states)
  }
  async readView(service: McpService) {
    if (service.configurationRequired) return { stage: 'failed' as const, updatedAt: 0, log: 'Reconfigure this service after the platform secret reset.' }
    if (!service.run) return undefined
    const states = await this.dependencies.inspect(service.run.runtimeDependencies ?? [])
    return this.status(service, states)
  }
  private status(service: McpService, states: readonly ReturnType<RuntimeDependencies['state']>[]) {
    return {
      ...(service.run?.location === 'shared' ? { isolated: this.options.isolated?.() ?? false } : {}),
      stage: states.some(row => row.stage === 'failed')
        ? ('failed' as const)
        : states.some(row => row.stage !== 'ready')
          ? ('preparing' as const)
          : ('ready' as const),
      updatedAt: Math.max(0, ...states.map(row => row.updatedAt)),
      log: states
        .map(row => row.log)
        .filter(Boolean)
        .join('\n'),
    }
  }
  private services(): readonly McpService[] {
    return this.store.view.read().services.flatMap(row => [row, ...(row.catalogUpdate?.candidate ? [row.catalogUpdate.candidate] : [])])
  }
  async changed(): Promise<void> {
    await this.dependencies.resumeManaged()
    await this.options.running?.reconcile()
    await this.dependencies.collectManagedCandidates()
  }
  async recover(): Promise<void> {
    await this.options.running?.recover()
  }
  start(): void {
    this.options.running?.start()
  }
  async stop(): Promise<void> {
    await this.options.running?.stop()
  }
  restart(name: string): void {
    const service = this.store.view.read().services.find(row => row.name === name)
    for (const dependency of service?.run?.runtimeDependencies ?? []) void this.dependencies.restartManaged(dependency)
  }
}
