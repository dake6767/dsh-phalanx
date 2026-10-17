import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { suiteEntryKinds, type SuiteExecutionSnapshot, type SuiteInstallRecord, type SuiteInstallState } from '../domain/suite-install.js'
import type { SuiteInstallStorePort } from '../ports/suite-catalog.js'
import { assertRuntimeDependencyRow } from './runtime-dependency-store.js'
import { assertLibrarySkillRow } from './skill-library-store.js'

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
      || !['installing', 'installed', 'failed', 'uninstalling', 'detaching'].includes(row.status)
      || !Array.isArray(row.entries) || row.entries.some(entry => !(suiteEntryKinds as readonly string[]).includes(entry.kind) || typeof entry.name !== 'string')
      || (row.requestId !== undefined && typeof row.requestId !== 'string') || !Number.isFinite(row.updatedAt) || typeof row.log !== 'string'
      || (row.failureCode !== undefined && typeof row.failureCode !== 'string')
      || (row.dependencies !== undefined && (!Array.isArray(row.dependencies) || row.dependencies.some(id => typeof id !== 'string')))
      || (row.manualDependencies !== undefined && (!Array.isArray(row.manualDependencies) || row.manualDependencies.some(item => typeof item?.id !== 'string' || typeof item?.name !== 'string')))
      || (row.replaced !== undefined && (!Array.isArray(row.replaced) || row.replaced.some(entry => (entry?.kind !== 'runtime-dependency' && entry?.kind !== 'skill') || typeof entry.name !== 'string')))
      || (row.replacing !== undefined && (!row.replacing || !Array.isArray(row.replacing.dependencies) || !Array.isArray(row.replacing.skills) || !Array.isArray(row.replacing.executions)
        || row.replacing.executions.some(item => !validExecutionSnapshot(item))))) throw new Error('Invalid suite install record')
    // Snapshot rows are written back into their own stores on restore, so they must pass those stores' checks.
    for (const dependency of row.replacing?.dependencies ?? []) assertRuntimeDependencyRow(dependency)
    for (const skill of row.replacing?.skills ?? []) assertLibrarySkillRow(skill)
  }
}

function validExecutionSnapshot(row: SuiteExecutionSnapshot): boolean {
  const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string')
  return !!row && typeof row.owner === 'string' && typeof row.enabled === 'boolean' && strings(row.runtimeDependencies)
    && Array.isArray(row.commands) && row.commands.every(command => typeof command?.command === 'string' && strings(command.blocked))
    && Array.isArray(row.variables) && row.variables.every(variable => typeof variable?.name === 'string' && typeof variable.secret === 'boolean' && typeof variable.hadValue === 'boolean')
    && (row.approvedContribution === undefined || typeof row.approvedContribution === 'string') && (row.awaitingPreparation === undefined || typeof row.awaitingPreparation === 'boolean')
    && (row.prepare === undefined || typeof row.prepare === 'string')
    && (row.contributionReceipt === undefined || typeof row.contributionReceipt?.id === 'string' && typeof row.contributionReceipt.revision === 'string')
}
