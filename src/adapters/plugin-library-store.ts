import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { assertPluginIdentity, type LibraryPlugin } from '../domain/plugin-library.js'
import type { PluginLibraryStorePort } from '../ports/plugin-library.js'

/** Independent private platform store, serialized by the process-wide platform lock. */
export class FilePluginLibraryStore implements PluginLibraryStorePort {
  private rows: readonly LibraryPlugin[] = []
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { schema?: number, plugins?: LibraryPlugin[] }
    if (stored.schema !== 1 || !Array.isArray(stored.plugins)) throw new Error('Invalid plugin library storage')
    const names = new Set<string>()
    for (const row of stored.plugins) {
      assertPluginIdentity(row)
      if (names.has(row.packageName) || !['resolving', 'downloading', 'installing', 'prechecking', 'available', 'failed'].includes(row.stage)
        || typeof row.published !== 'boolean' || (row.stage === 'available' && (row.current === null || row.current.packageName !== row.packageName || row.current.version !== row.version)))
        throw new Error('Invalid plugin library record')
      names.add(row.packageName)
    }
    this.rows = stored.plugins
    chmodSync(path, 0o600)
  }
  list(): readonly LibraryPlugin[] { return structuredClone(this.rows) }
  save(plugin: LibraryPlugin): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const next = [...this.rows.filter(row => row.packageName !== plugin.packageName), plugin]
    const temporary = `${this.path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, plugins: next }), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.path)
      this.rows = structuredClone(next)
    } finally { rmSync(temporary, { force: true }) }
  }
}
