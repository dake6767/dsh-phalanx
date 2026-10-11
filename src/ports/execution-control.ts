import type { ExecutionLimits, ExecutionRecord } from '../domain/execution-control.js'
export interface ExecutionLimitsPort { get(): ExecutionLimits; save(value: ExecutionLimits): void }
export interface ExecutionAuditPort { append(record: ExecutionRecord): void; list(): readonly ExecutionRecord[]; prune(before: number): void }
export interface ExecutionDeadlinePort { start(milliseconds: number): { readonly signal: AbortSignal, dispose(): void } }

export interface ExecutionMaintenancePort { start(cleanup: () => void): () => void }
