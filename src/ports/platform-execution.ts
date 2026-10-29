import type { ExecutionConfiguration, ExecutionEvent, ExecutionOwner, ExecutionRequest } from '../domain/platform-execution.js'
import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'

export interface ExecutionOwnersPort {
  get(id: string): ExecutionOwner | undefined
  owns(username: string, id: string): Promise<boolean>
}
export interface ExecutionOwnerInventoryPort extends ExecutionOwnersPort {
  identities(): readonly string[]
}
export interface ExecutionConfigurationPort {
  get(owner: string): Promise<ExecutionConfiguration | undefined>
}
export interface ExecutionMaterial {
  readonly version: string
  readonly dependencies?: readonly RuntimeDependencyVersion[]
}
export interface ExecutionMaterialPort {
  withPrepared<T>(owner: string, run: (material: ExecutionMaterial) => Promise<T>): Promise<T>
}
export interface ExecutionRunnerPort {
  run(
    request: ExecutionRequest & {
      readonly version: string
      readonly dependencies?: readonly RuntimeDependencyVersion[]
      readonly environment: Readonly<Record<string, string>>
    },
    emit: (event: ExecutionEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<number>
}
export interface ExecutionConfigurationStorePort extends ExecutionConfigurationPort {
  revision?(owner: string): Promise<string>
  remove(owner: string, expectedRevision?: string): Promise<void>
  list(): Promise<readonly { readonly owner: string; readonly configuration: ExecutionConfiguration }[]>
  save(owner: string, configuration: ExecutionConfiguration, expectedRevision?: string): Promise<void>
}
