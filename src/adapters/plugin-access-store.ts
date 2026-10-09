import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PluginAccessSettings } from '../domain/plugin-access.js'
import type { PluginAccessStorePort } from '../ports/plugin-access.js'
/** Durable per-package templates, outside reset carriers and never mounted wholesale. */
export class FilePluginAccessStore implements PluginAccessStorePort {
  private plugins: Record<string, PluginAccessSettings> = {}
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schema?: number, plugins?: Record<string, PluginAccessSettings> }
    if (value.schema !== 1 || !value.plugins || Array.isArray(value.plugins)) throw Error('Invalid plugin access store')
    for (const row of Object.values(value.plugins)) if (!row || !Array.isArray(row.environment) || typeof row.entriesYaml !== 'string' || !row.entries || typeof row.revision !== 'string') throw Error('Invalid plugin access settings')
    this.plugins = value.plugins; chmodSync(path, 0o600)
  }
  get(packageName: string) { const row = this.plugins[packageName]; return row ? structuredClone(row) : undefined }
  list() { return structuredClone(this.plugins) }
  save(packageName: string, settings: Omit<PluginAccessSettings, 'revision'>) {
    const prior = this.get(packageName)
    if (prior && JSON.stringify({ ...prior, revision: undefined }) === JSON.stringify(settings)) return
    this.persist({ ...this.plugins, [packageName]: { ...structuredClone(settings), revision: randomUUID() } })
  }
  remove(packageName: string) { const plugins = { ...this.plugins }; delete plugins[packageName]; this.persist(plugins) }
  private persist(plugins: Record<string, PluginAccessSettings>) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try { writeFileSync(temporary, JSON.stringify({ schema: 1, plugins }), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path); this.plugins = plugins }
    finally { rmSync(temporary, { force: true }) }
  }
}
