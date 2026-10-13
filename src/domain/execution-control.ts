import { BusinessRuleError } from './business-error.js'
import type { ExecutionFailureCode } from './platform-execution.js'
export interface ExecutionLimits {
  readonly memberConcurrency: number
  readonly platformConcurrency: number
  readonly timeoutSeconds: number
  readonly memoryMiB: number
  readonly cpus: number
  readonly pids: number
}
export const MAX_EXECUTION_TIMEOUT_SECONDS = 3600
export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = { memberConcurrency: 2, platformConcurrency: 8, timeoutSeconds: 120, memoryMiB: 512, cpus: 1, pids: 64 }
export interface ExecutionRecord {
  readonly username: string
  readonly owner: string
  readonly command: string
  readonly startedAt: number
  readonly durationMs: number
  readonly exitCode?: number
  readonly reason?: ExecutionFailureCode | 'cancelled'
}
export function executionLimits(value: ExecutionLimits): ExecutionLimits {
  if (!value || typeof value !== 'object') throw new BusinessRuleError('invalid', 'Check execution limits.', 'execution-config-invalid')
  const bounds: Record<keyof ExecutionLimits, readonly [number, number]> = { memberConcurrency: [1, 128], platformConcurrency: [1, 1024], timeoutSeconds: [1, MAX_EXECUTION_TIMEOUT_SECONDS], memoryMiB: [64, 65536], cpus: [0.1, 64], pids: [16, 4096] }
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const number = value[key as keyof ExecutionLimits]
    if (!Number.isFinite(number) || number < min || number > max || (key !== 'cpus' && !Number.isInteger(number))) throw new BusinessRuleError('invalid', 'Check execution limits.', 'execution-config-invalid')
  }
  return { memberConcurrency: value.memberConcurrency, platformConcurrency: value.platformConcurrency, timeoutSeconds: value.timeoutSeconds, memoryMiB: value.memoryMiB, cpus: value.cpus, pids: value.pids }
}
