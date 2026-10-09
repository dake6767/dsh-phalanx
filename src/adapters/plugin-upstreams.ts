import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { upstreamInput, type PluginUpstream } from '../domain/plugin-upstream.js'
import type { PluginUpstreamsPort } from '../ports/plugin-upstreams.js'

/** Platform-only credential carrier. Never copied to member mounts or public catalogs. */
export class FilePluginUpstreams implements PluginUpstreamsPort {
  private plugins: Record<string, readonly PluginUpstream[]> = {}
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    chmodSync(path, 0o600)
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schema?: number, plugins?: Record<string, PluginUpstream[]> }
    if (value.schema !== 1 || !value.plugins || Array.isArray(value.plugins)) throw new Error('Invalid plugin upstream store')
    for (const rows of Object.values(value.plugins)) {
      if (!Array.isArray(rows) || new Set(rows.map(row => row.name)).size !== rows.length) throw new Error('Invalid plugin upstream store')
      for (const row of rows) { upstreamInput(row); if (typeof row.credential !== 'string') throw new Error('Invalid plugin upstream store') }
    }
    this.plugins = value.plugins
  }
  list(packageName: string): readonly PluginUpstream[] { return structuredClone(this.plugins[packageName] ?? []) }
  save(packageName: string, upstreams: readonly PluginUpstream[]): void {
    const plugins = { ...this.plugins, [packageName]: structuredClone(upstreams) }
    if (!upstreams.length) delete plugins[packageName]
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, plugins }), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.path); this.plugins = plugins
    } finally { rmSync(temporary, { force: true }) }
  }
}
