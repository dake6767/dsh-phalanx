import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { executionConfiguration } from '../domain/execution-configuration.js'
import type { ExecutionConfiguration } from '../domain/platform-execution.js'
import type { ExecutionConfigurationStorePort } from '../ports/platform-execution.js'

/** Credentials stay in the protected platform data root, never a member projection. */
export class FileExecutionConfigurations implements ExecutionConfigurationStorePort {
  private revisions = new Map<string, string>()
  private configurations = new Map<string, ExecutionConfiguration>()
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    chmodSync(path, 0o600)
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      if (parsed.schema !== 1 || !Array.isArray(parsed.owners)) throw new Error()
      for (const row of parsed.owners) {
        if (typeof row.owner !== 'string' || this.configurations.has(row.owner)) throw new Error()
        if (row.revision !== undefined) { if (typeof row.revision !== 'string' || !row.revision) throw new Error(); this.revisions.set(row.owner, row.revision) }
        const value = executionConfiguration(row.configuration)
        const { contributionReceipt, awaitingPreparation, approvedContribution, suiteOrigin } = row.configuration
        if (contributionReceipt !== undefined && (!contributionReceipt || typeof contributionReceipt.id !== 'string' || typeof contributionReceipt.revision !== 'string') || awaitingPreparation !== undefined && typeof awaitingPreparation !== 'boolean' || approvedContribution !== undefined && (typeof approvedContribution !== 'string' || !approvedContribution) || suiteOrigin !== undefined && (typeof suiteOrigin !== 'string' || !suiteOrigin.startsWith('suite:'))) throw new Error()
        this.configurations.set(row.owner, { ...value, ...(contributionReceipt ? { contributionReceipt } : {}), ...(awaitingPreparation === undefined ? {} : { awaitingPreparation }), ...(approvedContribution ? { approvedContribution } : {}), ...(suiteOrigin ? { suiteOrigin } : {}) })
      }
    } catch { throw new Error('Execution configuration could not be loaded') }
  }
  revision(owner: string): string {
    if (!this.configurations.has(owner)) return 'none'
    if (!this.revisions.has(owner)) this.persist(this.configurations, new Map([...this.revisions, [owner, randomUUID()]]))
    return this.revisions.get(owner)!
  }
  get(owner: string): ExecutionConfiguration | undefined { return structuredClone(this.configurations.get(owner)) }
  list() { return [...this.configurations].map(([owner, configuration]) => ({ owner, configuration: structuredClone(configuration) })) }
  save(owner: string, configuration: ExecutionConfiguration): void {
    const next = new Map(this.configurations); next.set(owner, structuredClone(configuration))
    const revisions = JSON.stringify(this.configurations.get(owner)) === JSON.stringify(configuration) ? this.revisions : new Map([...this.revisions, [owner, randomUUID()]])
    this.persist(next, revisions)
  }
  retain(owners: readonly string[]): void {
    const next = new Map([...this.configurations].filter(([owner]) => owners.includes(owner)))
    if (next.size !== this.configurations.size) this.persist(next)
  }
  private persist(next: Map<string, ExecutionConfiguration>, revisions = this.revisions): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, owners: [...next].map(([owner, configuration]) => ({ owner, configuration, ...(revisions.has(owner) ? { revision: revisions.get(owner) } : {}) })) }), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.path); this.configurations = next; this.revisions = revisions
    } finally { rmSync(temporary, { force: true }) }
  }
}
