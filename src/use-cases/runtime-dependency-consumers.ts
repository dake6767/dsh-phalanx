import type { PluginLibraryStorePort } from '../ports/plugin-library.js'
import type { McpStorePort } from '../ports/mcp-services.js'
import type { RuntimeDependencyReference } from '../domain/runtime-dependency.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { ExecutionConfigurationStorePort } from '../ports/platform-execution.js'

export class RuntimeDependencyConsumers {
  constructor(private readonly skills: Pick<SkillLibraryStorePort, 'list'>, private readonly execution: Pick<ExecutionConfigurationStorePort, 'list'>, private readonly mcp?: Pick<McpStorePort, 'read'>, private readonly plugins?: Pick<PluginLibraryStorePort, 'list'>) {}
  list(name: string): readonly RuntimeDependencyReference[] {
    return [...(this.plugins?.list() ?? []).filter(row => row.runtimeDependencies?.includes(name)).map(row => ({ kind: 'plugin' as const, name: row.packageName })), ...this.skills.list().filter(row => row.runtimeDependencies?.includes(name)).map(row => ({ kind: 'skill' as const, name: row.name })),
      ...(this.mcp?.read().services ?? []).flatMap(row => [row, ...row.catalogUpdate?.candidate ? [row.catalogUpdate.candidate] : []]).filter(row => row.run?.runtimeDependencies?.includes(name) || row.dependencyPromotion?.from === name || row.dependencyPromotion?.to === name).map(row => ({ kind: 'mcp' as const, name: row.name })),
      ...this.execution.list().filter(row => row.configuration.runtimeDependencies?.includes(name)).map(row => ({ kind: 'execution' as const, name: row.owner }))]
  }
}
