import type { RuntimeDependencyReference } from '../domain/runtime-dependency.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'
import type { ExecutionConfigurationStorePort } from '../ports/platform-execution.js'

export class RuntimeDependencyConsumers {
  constructor(private readonly skills: Pick<SkillLibraryStorePort, 'list'>, private readonly execution: Pick<ExecutionConfigurationStorePort, 'list'>) {}
  list(name: string): readonly RuntimeDependencyReference[] {
    return [...this.skills.list().filter(row => row.runtimeDependencies?.includes(name)).map(row => ({ kind: 'skill' as const, name: row.name })),
      ...this.execution.list().filter(row => row.configuration.runtimeDependencies?.includes(name)).map(row => ({ kind: 'execution' as const, name: row.owner }))]
  }
}
