import type { McpService } from './mcp-service.js'

/** Scope names distinguish candidate and promotion roots while the SQL owner remains the root service. */
export function mcpRuntimeBindings(service: McpService, scope = 'current'): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, readonly string[]>()
  if (service.run?.runtimeDependencies) result.set(scope + '/run', service.run.runtimeDependencies)
  if (service.dependencyName) result.set(scope + '/own', [service.dependencyName])
  if (service.dependencyTarget) result.set(scope + '/target', [service.dependencyTarget])
  if (service.dependencyPromotion) {
    result.set(scope + '/promotion/from', [service.dependencyPromotion.from])
    result.set(scope + '/promotion/to', [service.dependencyPromotion.to])
  }
  if (service.catalogUpdate?.candidate)
    for (const [key, names] of mcpRuntimeBindings(service.catalogUpdate.candidate, scope + '/candidate')) result.set(key, names)
  return result
}

/** Metadata keeps only presence markers; relationship names are authoritative. */
export function mcpBindingMetadata(service: McpService): McpService {
  const { rowRevision, ...metadata } = service
  void rowRevision
  return {
    ...metadata,
    ...(service.run?.runtimeDependencies ? { run: { ...service.run, runtimeDependencies: [] } } : {}),
    ...(service.dependencyName ? { dependencyName: '' } : {}),
    ...(service.dependencyTarget ? { dependencyTarget: '' } : {}),
    ...(service.dependencyPromotion ? { dependencyPromotion: { from: '', to: '' } } : {}),
    ...(service.catalogUpdate?.candidate
      ? { catalogUpdate: { ...service.catalogUpdate, candidate: mcpBindingMetadata(service.catalogUpdate.candidate) } }
      : {}),
  }
}

export function withMcpRuntimeBindings(service: McpService, bindings: Readonly<Record<string, readonly string[]>>, scope = 'current'): McpService {
  const required = (role: string) => {
    const names = bindings[scope + '/' + role]
    if (names?.length !== 1) throw Error('Invalid MCP dependency relationship')
    return names[0]!
  }
  return {
    ...service,
    ...(service.run?.runtimeDependencies ? { run: { ...service.run, runtimeDependencies: bindings[scope + '/run'] ?? [] } } : {}),
    ...(service.dependencyName !== undefined ? { dependencyName: required('own') } : {}),
    ...(service.dependencyTarget !== undefined ? { dependencyTarget: required('target') } : {}),
    ...(service.dependencyPromotion ? { dependencyPromotion: { from: required('promotion/from'), to: required('promotion/to') } } : {}),
    ...(service.catalogUpdate?.candidate
      ? { catalogUpdate: { ...service.catalogUpdate, candidate: withMcpRuntimeBindings(service.catalogUpdate.candidate, bindings, scope + '/candidate') } }
      : {}),
  }
}
