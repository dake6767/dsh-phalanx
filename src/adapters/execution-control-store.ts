import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { DEFAULT_EXECUTION_LIMITS, executionLimits, type ExecutionLimits, type ExecutionRecord } from '../domain/execution-control.js'
import type { ExecutionAuditPort, ExecutionDeadlinePort, ExecutionLimitsPort, ExecutionMaintenancePort } from '../ports/execution-control.js'

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
export class FileExecutionAudit implements ExecutionAuditPort {
  private rows: readonly ExecutionRecord[]
  constructor(private readonly path: string) {
    this.rows = read(path, [])
    if (!Array.isArray(this.rows) || this.rows.some(row => !row || typeof row.username !== 'string' || typeof row.owner !== 'string' || typeof row.command !== 'string' || !Number.isFinite(row.startedAt) || !Number.isFinite(row.durationMs))) throw new Error('Invalid execution audit')
  }
  list(): readonly ExecutionRecord[] { return structuredClone(this.rows) }
  append(record: ExecutionRecord): void {
    const row: ExecutionRecord = { username: record.username, owner: record.owner, command: record.command, startedAt: record.startedAt, durationMs: record.durationMs, ...(record.reason ? { reason: record.reason } : { exitCode: record.exitCode! }) }
    const next = [...this.rows, row]; save(this.path, next); this.rows = next
  }
  prune(before: number): void { const next = this.rows.filter(row => row.startedAt >= before); if (next.length !== this.rows.length) { save(this.path, next); this.rows = next } }
}
export class ExecutionDeadlines implements ExecutionDeadlinePort {
  start(milliseconds: number) { const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), milliseconds); timer.unref(); return { signal: controller.signal, dispose: () => clearTimeout(timer) } }
}

export class ExecutionMaintenance implements ExecutionMaintenancePort {
  constructor(private readonly intervalMs = 60 * 60 * 1000) {}
  start(cleanup: () => void): () => void {
    const timer = setInterval(() => { try { cleanup() } catch { console.warn('Execution audit cleanup failed; retrying at the next interval') } }, this.intervalMs)
    timer.unref(); return () => clearInterval(timer)
  }
}
