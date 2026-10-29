import { isDeepStrictEqual } from 'node:util'
import { BusinessRuleError } from '../domain/business-error.js'
import type { McpService, McpState } from '../domain/mcp-service.js'
import { mcpSecretContext, normalizeMcpProtectedValues } from '../domain/mcp-protected-values.js'
import type { McpMutationOptions, McpPolicyView, McpRepositories, McpRuntimePort, McpSnapshot, McpStatePort, McpStateQueryPort } from '../ports/mcp-services.js'
import type { PlatformUnitOfWorkPort } from '../ports/platform-unit-of-work.js'

const names = (values: readonly string[] | undefined) => (values === undefined ? undefined : [...new Set(values)].sort())
const record = (service: McpService) => {
  const { rowRevision, ...value } = service
  void rowRevision
  return value
}
const configuring = (service: McpService): boolean =>
  !service.configurationRequired &&
  (!!service.dependencyPromotion ||
    service.run?.prepareCommand !== undefined ||
    !!(service.catalogUpdate?.candidate && configuring(service.catalogUpdate.candidate)))
const generations = (service: McpService): readonly number[] => [
  service.generation,
  ...(service.catalogUpdate?.candidate ? generations(service.catalogUpdate.candidate) : []),
]

/** Temporary application projections become row diffs; every changed owner has its own optimistic revision. */
export class McpDesiredState implements McpStatePort {
  private readonly writes = new Set<Promise<void>>()
  private closed = false
  constructor(
    private readonly query: McpStateQueryPort,
    private readonly work: PlatformUnitOfWorkPort<McpRepositories>,
    readonly view: McpPolicyView,
  ) {}
  async read(): Promise<McpSnapshot> {
    this.open()
    return this.query.read()
  }
  update(previous: McpSnapshot, next: McpState, options?: McpMutationOptions): Promise<void> {
    return this.accept(() => this.apply(previous, next, undefined, options))
  }
  async reconcile(runtime?: McpRuntimePort): Promise<void> {
    const previous = await this.read()
    return this.accept(() => this.apply(previous, previous, runtime))
  }
  async stop(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.writes])
  }
  private accept(operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(Error('MCP storage is closed'))
    const writing = operation()
    this.writes.add(writing)
    return writing.finally(() => {
      this.writes.delete(writing)
    })
  }
  private async apply(previous: McpSnapshot, next: McpState, runtime?: McpRuntimePort, options?: McpMutationOptions): Promise<void> {
    const context = mcpSecretContext([...previous.services, ...next.services])
    let services = next.services.map(service => normalizeMcpProtectedValues(service, context))
    if (new Set(services.map(row => row.name)).size !== services.length)
      throw new BusinessRuleError('invalid', 'Duplicate MCP service names.', 'mcp-service-invalid')
    const old = new Map(previous.services.map(row => [row.name, row]))
    const groups = [...new Set([...Object.keys(previous.grants), ...Object.keys(next.grants)])]
      .sort()
      .filter(id => !isDeepStrictEqual(names(previous.grants[id]), names(next.grants[id])))
    const spaces = [
      ...new Set([
        ...Object.keys(previous.selections ?? {}),
        ...Object.keys(previous.preferences ?? {}),
        ...Object.keys(next.selections ?? {}),
        ...Object.keys(next.preferences ?? {}),
      ]),
    ]
      .sort()
      .filter(
        id =>
          !isDeepStrictEqual(names(previous.selections?.[id]), names(next.selections?.[id])) ||
          !isDeepStrictEqual(previous.preferences?.[id], next.preferences?.[id]),
      )
    const changed = new Set(
      [...old.keys(), ...services.map(row => row.name)].filter(name => {
        const current = old.get(name),
          value = services.find(row => row.name === name)
        return !current || !value || !isDeepStrictEqual(record(current), record(value))
      }),
    )
    const targets = new Set(changed)
    if (runtime?.transaction) for (const row of services) if (configuring(row)) targets.add(row.name)
    for (const id of groups) for (const name of next.grants[id] ?? []) targets.add(name)
    for (const id of spaces) {
      for (const name of [...(next.selections?.[id] ?? []), ...Object.keys(next.preferences?.[id] ?? {})]) targets.add(name)
      for (const name of next.selections?.[id] ?? [])
        if (!previous.selections?.[id]?.includes(name) && !services.find(row => row.name === name)?.published)
          throw new BusinessRuleError('forbidden', 'MCP service is unavailable.', 'mcp-grant-invalid')
    }
    await this.work.run(
      async rows => {
        for (const name of [...targets].sort()) await rows.services.lock(name, previous.versions.services[name] ?? 'none')
        const scope = runtime?.transaction?.(rows.runtime)
        if (runtime?.configure && !scope) throw Error('MCP runtime mutations require a shared transaction')
        if (scope) {
          const configured: McpService[] = []
          for (const service of services) {
            const current = await scope.configure(service)
            configured.push(
              current.catalogUpdate?.candidate
                ? { ...current, catalogUpdate: { ...current.catalogUpdate, candidate: await scope.configure(current.catalogUpdate.candidate) } }
                : current,
            )
          }
          services = configured.map(row => normalizeMcpProtectedValues(row, context))
        }
        const modified = services.filter(row => !old.has(row.name) || !isDeepStrictEqual(record(old.get(row.name)!), record(row)))
        // New parents must exist before policies; existing unpublishes purge even concurrently added selections after policy CAS.
        for (const service of modified.filter(row => !old.has(row.name))) await rows.services.save(service, context, 'none')
        for (const id of groups) {
          if (Object.hasOwn(next.grants, id)) await rows.policies.saveGroup(id, names(next.grants[id])!, previous.versions.groups[id] ?? 'none')
          else await rows.policies.removeGroup(id, previous.versions.groups[id] ?? 'none')
        }
        for (const id of spaces) {
          const selections = names(next.selections?.[id]),
            preferences = next.preferences?.[id]
          if (selections !== undefined || preferences !== undefined)
            await rows.policies.saveMember(id, selections, preferences, previous.versions.members[id] ?? 'none')
          else await rows.policies.removeMember(id, previous.versions.members[id] ?? 'none')
        }
        for (const service of modified.filter(row => old.has(row.name))) await rows.services.save(service, context, previous.versions.services[service.name]!)
        const removed = previous.services.filter(row => !services.some(next => next.name === row.name))
        if (removed.length) {
          if (options?.expertReferenceRevision !== undefined && !rows.expertReferences) throw Error('Expert reference retirement requires a shared transaction')
          await rows.expertReferences?.detach(
            removed.map(row => ({ kind: 'mcp', name: row.name })),
            options?.expertReferenceRevision,
          )
        }
        for (const service of removed) await rows.services.remove(service.name, previous.versions.services[service.name]!)
        await rows.metadata.advance(
          previous.revision ?? 0,
          Math.max(previous.revision ?? 0, next.revision ?? 0, ...previous.services.flatMap(generations), ...services.flatMap(generations)),
          services.some(row => row.catalogUpdate?.candidate && row.catalogUpdate.name !== old.get(row.name)?.catalogUpdate?.name),
        )
        await rows.metadata.appendRequests((next.catalogRequests ?? []).filter(name => !previous.catalogRequests?.includes(name)))
        return scope
      },
      scope => scope?.committed(),
    )
  }
  private open(): void {
    if (this.closed) throw Error('MCP storage is closed')
  }
}
