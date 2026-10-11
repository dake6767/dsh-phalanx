import type { ExecutionConfiguration, ExecutionOwner } from '../domain/platform-execution.js'
import type { PreparedExecution, ExecutionPreparationRecord } from '../domain/execution-preparation.js'
export interface ExecutionPreparationStorePort {
  retain(owners: readonly string[]): void
  list(): readonly ExecutionPreparationRecord[]
  get(owner: string): ExecutionPreparationRecord | undefined
  save(owner: string, record: ExecutionPreparationRecord): void
}
export interface ExecutionPreparerPort {
  identity(owner: ExecutionOwner, configuration: ExecutionConfiguration): string
  recover(): Promise<void>
  collect(retained: readonly string[]): Promise<void>
  prepare(owner: ExecutionOwner, configuration: ExecutionConfiguration, signal: AbortSignal): Promise<PreparedExecution>
}
