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
      if (row.removing !== undefined && typeof row.removing !== 'boolean') throw new Error('Invalid plugin removal record')
      if (row.identities !== undefined) {
        if (!row.identities || typeof row.identities !== 'object' || Array.isArray(row.identities)) throw new Error('Invalid plugin identities')
        for (const [version, integrity] of Object.entries(row.identities)) {
          assertPluginIdentity({ packageName: row.packageName, version })
          if (typeof integrity !== 'string' || !integrity) throw new Error('Invalid plugin integrity')
        }
      }
      if (row.replacement) {
        assertPluginIdentity(row.replacement)
        if (row.replacement.packageName !== row.packageName || !['resolving', 'downloading', 'installing', 'prechecking', 'available', 'failed'].includes(row.replacement.stage)
          || (row.replacement.stage === 'available' && (!row.replacement.prepared || row.replacement.prepared.packageName !== row.packageName || row.replacement.prepared.version !== row.replacement.version)))
          throw new Error('Invalid plugin replacement record')
      }
      names.add(row.packageName)
    }
    this.rows = stored.plugins
    chmodSync(path, 0o600)
  }
  list(): readonly LibraryPlugin[] { return structuredClone(this.rows) }
  save(plugin: LibraryPlugin): void {
    this.persist([...this.rows.filter(row => row.packageName !== plugin.packageName), plugin])
  }
  remove(packageName: string): void { this.persist(this.rows.filter(row => row.packageName !== packageName)) }
  private persist(next: readonly LibraryPlugin[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, plugins: next }), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.path)
      this.rows = structuredClone(next)
    } finally { rmSync(temporary, { force: true }) }
  }
}
