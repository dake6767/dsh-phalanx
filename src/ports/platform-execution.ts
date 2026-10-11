import type { ExecutionConfiguration, ExecutionEvent, ExecutionOwner, ExecutionRequest } from '../domain/platform-execution.js'

export interface ExecutionOwnersPort {
  get(id: string): ExecutionOwner | undefined
  owns(username: string, id: string): boolean
}
export interface ExecutionConfigurationPort {
  get(owner: string): ExecutionConfiguration | undefined
}
export interface ExecutionRunnerPort {
  run(request: ExecutionRequest & { readonly version: string, readonly artifact?: string, readonly environment: Readonly<Record<string, string>> },
    emit: (event: ExecutionEvent) => Promise<void>, signal: AbortSignal): Promise<number>
}
export interface ExecutionConfigurationStorePort extends ExecutionConfigurationPort {
  list(): readonly { readonly owner: string, readonly configuration: ExecutionConfiguration }[]
  save(owner: string, configuration: ExecutionConfiguration): void
}
