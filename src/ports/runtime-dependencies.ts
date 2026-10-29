import type {
  RuntimeDependencyDefinition,
  RuntimeDependency,
  RuntimeDependencyReference,
  RuntimeDependencyVersion,
  RuntimeDependencyCheck,
} from '../domain/runtime-dependency.js'

export interface RuntimeDependencyStorePort {
  list(): Promise<readonly RuntimeDependency[]>
  save(row: RuntimeDependency): Promise<void>
  remove(name: string): Promise<void>
}
/** Explicit committed facts used only by synchronous readiness and lease fences. */
export interface RuntimeDependencyView {
  list(): readonly RuntimeDependency[]
  version(): string
}
export interface RuntimeDependencyStoragePort extends RuntimeDependencyStorePort {
  readonly view: RuntimeDependencyView
}
export interface RuntimeDependencyReferencesPort {
  retained?(): Promise<readonly string[]>
  list(name: string): Promise<readonly RuntimeDependencyReference[]>
}
export interface RuntimeDependencyPreparerPort {
  readonly isolated: boolean
  recover(): Promise<void>
  identity(input: RuntimeDependencyDefinition): string
  prepare(
    input: RuntimeDependencyDefinition,
    progress: (log: string, checks?: readonly RuntimeDependencyCheck[]) => Promise<void>,
    signal: AbortSignal,
  ): Promise<RuntimeDependencyVersion>
  collect(retained: readonly string[]): Promise<void>
}
