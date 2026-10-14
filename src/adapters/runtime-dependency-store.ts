import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { runtimeDependencyInput, type RuntimeDependency } from '../domain/runtime-dependency.js'
import type { RuntimeDependencyStorePort } from '../ports/runtime-dependencies.js'

/** Atomic, private platform metadata; member configuration never owns dependency versions. */
export class FileRuntimeDependencyStore implements RuntimeDependencyStorePort {
  private rows: readonly RuntimeDependency[] = []
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { schema?: number, dependencies?: RuntimeDependency[] }
    if (stored.schema !== 1 || !Array.isArray(stored.dependencies)) throw new Error('Invalid runtime dependency storage')
    const names = new Set<string>()
    for (const row of stored.dependencies) {
      runtimeDependencyInput({ name: row.name, prepareCommand: row.prepareCommand, pathDirectories: row.pathDirectories, ...(row.checkCommand !== undefined ? { checkCommand: row.checkCommand } : {}) })
      if (names.has(row.name) || !['manual', 'mcp-catalog', 'migration-0.1.10'].includes(row.source)
        || !['preparing', 'validating', 'ready', 'failed'].includes(row.stage) || !Number.isFinite(row.updatedAt) || typeof row.log !== 'string' || !Array.isArray(row.checks)
        || (row.stage === 'ready' && !row.current)) throw new Error('Invalid runtime dependency record')
      for (const version of [row.current, row.previous]) if (version && (!/^[a-f0-9]{64}$/u.test(version.id) || typeof version.identity !== 'string'
        || typeof version.directory !== 'string' || typeof version.mountedPath !== 'string' || !Array.isArray(version.pathDirectories) || !Array.isArray(version.commands)
        || !version.commands.every(command => typeof command === 'string') || !Number.isFinite(version.bytes) || typeof version.isolated !== 'boolean'
        || !Array.isArray(version.checks) || typeof version.log !== 'string')) throw new Error('Invalid runtime dependency version')
      names.add(row.name)
    }
    this.rows = stored.dependencies; chmodSync(path, 0o600)
  }
  list(): readonly RuntimeDependency[] { return structuredClone(this.rows) }
  save(row: RuntimeDependency): void { this.persist([...this.rows.filter(item => item.name !== row.name), row]) }
  remove(name: string): void { this.persist(this.rows.filter(row => row.name !== name)) }
  private persist(next: readonly RuntimeDependency[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, dependencies: next }), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.path); this.rows = structuredClone(next)
    } finally { rmSync(temporary, { force: true }) }
  }
}
