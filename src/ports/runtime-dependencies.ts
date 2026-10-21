import type { RuntimeDependencyDefinition, RuntimeDependency, RuntimeDependencyReference, RuntimeDependencyVersion, RuntimeDependencyCheck } from '../domain/runtime-dependency.js'

export interface RuntimeDependencyStorePort {
  version?(): number
  list(): readonly RuntimeDependency[]
  save(row: RuntimeDependency): void
  remove(name: string): void
}
export interface RuntimeDependencyReferencesPort {
  retained?(): Promise<readonly string[]>
  list(name: string): readonly RuntimeDependencyReference[]
}
export interface RuntimeDependencyPreparerPort {
  readonly isolated: boolean
  recover(): Promise<void>
  identity(input: RuntimeDependencyDefinition): string
  prepare(input: RuntimeDependencyDefinition, progress: (log: string, checks?: readonly RuntimeDependencyCheck[]) => Promise<void>, signal: AbortSignal): Promise<RuntimeDependencyVersion>
  collect(retained: readonly string[]): Promise<void>
}
