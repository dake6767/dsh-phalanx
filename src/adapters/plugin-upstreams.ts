import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { upstreamInput, type PluginUpstream } from '../domain/plugin-upstream.js'
import type { PluginUpstreamsPort } from '../ports/plugin-upstreams.js'

/** Platform-only credential carrier. Never copied to member mounts or public catalogs. */
export class FilePluginUpstreams implements PluginUpstreamsPort {
  private revisions: Record<string, string> = {}
  private receipts: Record<string, ContributionReceipt> = {}
  private plugins: Record<string, readonly PluginUpstream[]> = {}
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    chmodSync(path, 0o600)
    const value = JSON.parse(readFileSync(path, 'utf8')) as { revisions?: Record<string, string>, schema?: number, plugins?: Record<string, PluginUpstream[]>, receipts?: Record<string, ContributionReceipt> }
    if (value.schema !== 1 || !value.plugins || Array.isArray(value.plugins)) throw new Error('Invalid plugin upstream store')
    for (const rows of Object.values(value.plugins)) {
      if (!Array.isArray(rows) || new Set(rows.map(row => row.name)).size !== rows.length) throw new Error('Invalid plugin upstream store')
      for (const row of rows) { upstreamInput(row); if (typeof row.credential !== 'string') throw new Error('Invalid plugin upstream store') }
    }
    this.plugins = value.plugins; this.receipts = value.receipts ?? {}; this.revisions = value.revisions ?? {}
  }
  list(packageName: string): readonly PluginUpstream[] { return structuredClone(Object.hasOwn(this.plugins, packageName) ? this.plugins[packageName]! : []) }
  revision(packageName: string): string {
    if (!this.list(packageName).length) return 'none'
    if (!Object.hasOwn(this.revisions, packageName)) this.persist(this.plugins, this.receipts, { ...this.revisions, [packageName]: randomUUID() })
    return this.revisions[packageName]!
  }
  receipt(packageName: string) { const receipt = Object.hasOwn(this.receipts, packageName) ? this.receipts[packageName] : undefined; return receipt ? { ...receipt } : undefined }
  save(packageName: string, upstreams: readonly PluginUpstream[], contribution?: ContributionReceipt): void {
    const receipts = contribution ? { ...this.receipts, [packageName]: contribution } : this.receipts
    const plugins = { ...this.plugins, [packageName]: structuredClone(upstreams) }
    if (!upstreams.length) delete plugins[packageName]
    const revisions = JSON.stringify(this.list(packageName)) === JSON.stringify(upstreams) ? this.revisions : { ...this.revisions, [packageName]: randomUUID() }
    this.persist(plugins, receipts, revisions)
  }
  private persist(plugins: Record<string, readonly PluginUpstream[]>, receipts = this.receipts, revisions = this.revisions): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, plugins, receipts, revisions }), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.path); this.plugins = plugins; this.receipts = receipts; this.revisions = revisions
    } finally { rmSync(temporary, { force: true }) }
  }
}
