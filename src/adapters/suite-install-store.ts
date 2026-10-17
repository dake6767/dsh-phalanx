import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SuiteInstallRecord, SuiteInstallState } from '../domain/suite-install.js'
import type { SuiteInstallStorePort } from '../ports/suite-catalog.js'

/** Atomic, private suite install records; receipts dedup repeated install requests. */
export class FileSuiteInstallStore implements SuiteInstallStorePort {
  private state: SuiteInstallState = { installs: [] }
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const stored = JSON.parse(readFileSync(path, 'utf8')) as SuiteInstallState & { schema: number }
    if (stored.schema !== 1 || !Array.isArray(stored.installs) || new Set(stored.installs.map(row => row.id)).size !== stored.installs.length) throw new Error('Invalid suite install storage')
    for (const row of stored.installs) this.validate(row)
    if (stored.requests !== undefined && (!Array.isArray(stored.requests) || stored.requests.some(id => typeof id !== 'string'))) throw new Error('Invalid suite install receipts')
    this.state = { ...(stored.requests ? { requests: stored.requests } : {}), installs: stored.installs }
    chmodSync(path, 0o600)
  }
  read(): SuiteInstallState { return structuredClone(this.state) }
  write(state: SuiteInstallState): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, ...state }), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.path); this.state = structuredClone(state)
    } finally { rmSync(temporary, { force: true }) }
  }
  private validate(row: SuiteInstallRecord): void {
    if (typeof row.id !== 'string' || !row.id || typeof row.version !== 'string' || !row.version
      || !['installing', 'installed', 'failed', 'uninstalling'].includes(row.status)
      || !Array.isArray(row.entries) || row.entries.some(entry => entry.kind !== 'runtime-dependency' || typeof entry.name !== 'string')
      || (row.requestId !== undefined && typeof row.requestId !== 'string') || !Number.isFinite(row.updatedAt) || typeof row.log !== 'string'
      || (row.failureCode !== undefined && typeof row.failureCode !== 'string')) throw new Error('Invalid suite install record')
  }
}
