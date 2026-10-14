import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import type { ExecutionConfiguration, ExecutionEvent, ExecutionOwner, ExecutionRequest } from '../domain/platform-execution.js'

export interface ExecutionOwnersPort {
  get(id: string): ExecutionOwner | undefined
  owns(username: string, id: string): boolean
}
export interface ExecutionOwnerInventoryPort extends ExecutionOwnersPort {
  identities(): readonly string[]
}
export interface ExecutionConfigurationPort {
  get(owner: string): ExecutionConfiguration | undefined
}
export interface ExecutionMaterial { readonly version: string, readonly id?: string, readonly dependencies?: readonly RuntimeDependencyVersion[], readonly sourceDependency?: RuntimeDependencyVersion }
export interface ExecutionMaterialPort { withPrepared<T>(owner: string, run: (material: ExecutionMaterial) => Promise<T>): Promise<T> }
export interface ExecutionRunnerPort {
  run(request: ExecutionRequest & { readonly version: string, readonly artifact?: string, readonly dependencies?: readonly RuntimeDependencyVersion[], readonly sourceDependency?: RuntimeDependencyVersion, readonly environment: Readonly<Record<string, string>> },
    emit: (event: ExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<number>
}
export interface ExecutionConfigurationStorePort extends ExecutionConfigurationPort {
  revision?(owner: string): string
  retain(owners: readonly string[]): void
  list(): readonly { readonly owner: string, readonly configuration: ExecutionConfiguration }[]
  save(owner: string, configuration: ExecutionConfiguration): void
}
