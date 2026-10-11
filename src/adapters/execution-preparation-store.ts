import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ExecutionPreparationRecord } from '../domain/execution-preparation.js'
import type { ExecutionPreparationStorePort } from '../ports/execution-preparation.js'

/** Private progress and immutable artifact identities survive service and image upgrades. */
export class FileExecutionPreparations implements ExecutionPreparationStorePort {
  private records: Map<string, ExecutionPreparationRecord>
  constructor(private readonly path: string) {
    if (!existsSync(path)) { this.records = new Map(); return }
    chmodSync(path, 0o600)
    const data = JSON.parse(readFileSync(path, 'utf8'))
    if (data.schema !== 1 || !Array.isArray(data.owners)) throw new Error('Invalid execution preparation state')
    this.records = new Map(data.owners.map((row: { owner: string, record: ExecutionPreparationRecord }) => {
      if (typeof row.owner !== 'string' || !row.record || !['preparing', 'ready', 'failed'].includes(row.record.stage)
        || typeof row.record.identity !== 'string' || !Number.isFinite(row.record.updatedAt) || typeof row.record.log !== 'string'
        || (row.record.artifact && (!/^[a-f0-9]{64}$/u.test(row.record.artifact.id) || !/^[a-f0-9]{64}$/u.test(row.record.artifact.hash)
          || !/^[a-f0-9]{64}$/u.test(row.record.artifact.version)))) throw new Error('Invalid execution preparation state')
      return [row.owner, row.record]
    }))
  }
  list(): readonly ExecutionPreparationRecord[] { return structuredClone([...this.records.values()]) }
  get(owner: string): ExecutionPreparationRecord | undefined { return structuredClone(this.records.get(owner)) }
  save(owner: string, record: ExecutionPreparationRecord): void {
    const records = new Map(this.records); records.set(owner, structuredClone(record))
    this.persist(records)
  }
  retain(owners: readonly string[]): void {
    const records = new Map([...this.records].filter(([owner]) => owners.includes(owner)))
    if (records.size !== this.records.size) this.persist(records)
  }
  private persist(records: Map<string, ExecutionPreparationRecord>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = this.path + '.' + randomUUID()
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, owners: [...records].map(([owner, value]) => ({ owner, record: value })) }), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.path); this.records = records
    } finally { rmSync(temporary, { force: true }) }
  }
}
