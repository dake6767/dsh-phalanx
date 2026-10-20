import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { DEFAULT_EXECUTION_LIMITS, executionLimits, type ExecutionLimits } from '../domain/execution-control.js'
import type { ExecutionDeadlinePort, ExecutionLimitsPort, ExecutionMaintenancePort } from '../ports/execution-control.js'

function read<T>(path: string, fallback: T): T {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback; throw error }
}
function save(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.' + randomUUID()
  try { writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' }); renameSync(temporary, path) }
  finally { rmSync(temporary, { force: true }) }
}
export class FileExecutionLimits implements ExecutionLimitsPort {
  private value: ExecutionLimits
  constructor(private readonly path: string) { this.value = executionLimits(read(path, DEFAULT_EXECUTION_LIMITS)) }
  get(): ExecutionLimits { return { ...this.value } }
  save(value: ExecutionLimits): void { const next = executionLimits(value); save(this.path, next); this.value = next }
}
export class ExecutionDeadlines implements ExecutionDeadlinePort {
  start(milliseconds: number) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), milliseconds); timer.unref(); return { signal: controller.signal, dispose: () => clearTimeout(timer) } }
}

export class ExecutionMaintenance implements ExecutionMaintenancePort {
  constructor(private readonly intervalMs = 60 * 60 * 1000) {}
  start(cleanup: () => void): () => void {
    const timer = setInterval(() => { try { cleanup() } catch { console.warn('Scheduled cleanup failed; retrying at the next interval') } }, this.intervalMs)
    timer.unref(); return () => clearInterval(timer)
  }
}
