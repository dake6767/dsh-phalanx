import type { ExecutionLimits } from '../domain/execution-control.js'
export interface ExecutionLimitsPort { get(): ExecutionLimits; save(value: ExecutionLimits): void }
export interface ExecutionDeadlinePort { start(milliseconds: number): { readonly signal: AbortSignal, dispose(): void } }

export interface ExecutionMaintenancePort { start(cleanup: () => void): () => void }
