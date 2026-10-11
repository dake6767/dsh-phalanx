import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { executionConfiguration } from '../domain/execution-configuration.js'
import type { ExecutionConfiguration } from '../domain/platform-execution.js'
import type { ExecutionConfigurationStorePort } from '../ports/platform-execution.js'

/** Credentials stay in the protected platform data root, never a member projection. */
export class FileExecutionConfigurations implements ExecutionConfigurationStorePort {
  private configurations = new Map<string, ExecutionConfiguration>()
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    chmodSync(path, 0o600)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed.schema !== 1 || !Array.isArray(parsed.owners)) throw new Error()
      for (const row of parsed.owners) {
        if (typeof row.owner !== 'string' || this.configurations.has(row.owner)) throw new Error()
        this.configurations.set(row.owner, executionConfiguration(row.configuration))
      }
    } catch { throw new Error('Execution configuration could not be loaded') }
  }
  get(owner: string): ExecutionConfiguration | undefined { return structuredClone(this.configurations.get(owner)) }
  list() { return [...this.configurations].map(([owner, configuration]) => ({ owner, configuration: structuredClone(configuration) })) }
  save(owner: string, configuration: ExecutionConfiguration): void {
    const next = new Map(this.configurations); next.set(owner, structuredClone(configuration))
    this.persist(next)
  }
  retain(owners: readonly string[]): void {
    const next = new Map([...this.configurations].filter(([owner]) => owners.includes(owner)))
    if (next.size !== this.configurations.size) this.persist(next)
  }
  private persist(next: Map<string, ExecutionConfiguration>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, owners: [...next].map(([owner, configuration]) => ({ owner, configuration })) }), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.path); this.configurations = next
    } finally { rmSync(temporary, { force: true }) }
  }
}
