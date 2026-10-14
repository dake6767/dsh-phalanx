import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PluginAccessSettings } from '../domain/plugin-access.js'
import type { PluginAccessStorePort } from '../ports/plugin-access.js'
/** Durable per-package templates, outside reset carriers and never mounted wholesale. */
export class FilePluginAccessStore implements PluginAccessStorePort {
  private receipts: Record<string, ContributionReceipt> = {}
  private plugins: Record<string, PluginAccessSettings> = {}
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schema?: number, plugins?: Record<string, PluginAccessSettings>, receipts?: Record<string, ContributionReceipt> }
    if (value.schema !== 1 || !value.plugins || Array.isArray(value.plugins)) throw Error('Invalid plugin access store')
    for (const row of Object.values(value.plugins)) if (!row || !Array.isArray(row.environment) || typeof row.entriesYaml !== 'string' || !row.entries || typeof row.revision !== 'string') throw Error('Invalid plugin access settings')
    this.plugins = value.plugins; this.receipts = value.receipts ?? {}; chmodSync(path, 0o600)
  }
  get(packageName: string) { const row = this.plugins[packageName]; return row ? structuredClone(row) : undefined }
  list() { return structuredClone(this.plugins) }
  commitContribution(packageName: string, settings: Omit<PluginAccessSettings, 'revision'> | undefined, contribution: ContributionReceipt) {
    if (settings) this.save(packageName, settings, contribution)
    else { const plugins = { ...this.plugins }; delete plugins[packageName]; this.persist(plugins, { ...this.receipts, [packageName]: contribution }) }
  }
  receipt(packageName: string) { const receipt = this.receipts[packageName]; return receipt ? { ...receipt } : undefined }
  save(packageName: string, settings: Omit<PluginAccessSettings, 'revision'>, contribution?: ContributionReceipt) {
    const prior = this.get(packageName)
    const receipts = contribution ? { ...this.receipts, [packageName]: contribution } : this.receipts
    if (prior && JSON.stringify({ ...prior, revision: undefined }) === JSON.stringify(settings)) { if (contribution) this.persist(this.plugins, receipts); return }
    this.persist({ ...this.plugins, [packageName]: { ...structuredClone(settings), revision: randomUUID() } }, receipts)
  }
  remove(packageName: string) { const plugins = { ...this.plugins }; delete plugins[packageName]; this.persist(plugins) }
  private persist(plugins: Record<string, PluginAccessSettings>, receipts = this.receipts) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try { writeFileSync(temporary, JSON.stringify({ schema: 1, plugins, receipts }), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path); this.plugins = plugins; this.receipts = receipts }
    finally { rmSync(temporary, { force: true }) }
  }
}
