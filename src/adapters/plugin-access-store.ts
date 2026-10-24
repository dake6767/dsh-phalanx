import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PluginAccessCheckpoint, PluginAccessSettings } from '../domain/plugin-access.js'
import type { PluginAccessStorePort } from '../ports/plugin-access.js'
/** Durable per-package templates, outside reset carriers and never mounted wholesale. */
export class FilePluginAccessStore implements PluginAccessStorePort {
  private receipts: Record<string, ContributionReceipt> = {}
  private plugins: Record<string, PluginAccessSettings> = {}
  private checkpoints: Record<string, PluginAccessCheckpoint> = {}
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schema?: number, plugins?: Record<string, PluginAccessSettings>, receipts?: Record<string, ContributionReceipt>, suite?: Record<string, PluginAccessCheckpoint> }
    if (value.schema !== 1 || !value.plugins || Array.isArray(value.plugins)) throw Error('Invalid plugin access store')
    for (const row of Object.values(value.plugins)) if (!row || !Array.isArray(row.environment) || typeof row.entriesYaml !== 'string' || !row.entries || typeof row.revision !== 'string') throw Error('Invalid plugin access settings')
    for (const row of Object.values(value.suite ?? {})) if (!row || typeof row.task !== 'string' || typeof row.appliedRevision !== 'string') throw Error('Invalid plugin access checkpoint')
    this.plugins = value.plugins; this.receipts = value.receipts ?? {}; this.checkpoints = value.suite ?? {}; chmodSync(path, 0o600)
  }
  suiteCheckpoint(packageName: string) { const row = Object.hasOwn(this.checkpoints, packageName) ? this.checkpoints[packageName] : undefined; return row ? structuredClone(row) : undefined }
  saveSuiteCheckpoint(packageName: string, checkpoint: PluginAccessCheckpoint | undefined) {
    const suite = { ...this.checkpoints }
    if (checkpoint) suite[packageName] = checkpoint
    else delete suite[packageName]
    this.persist(this.plugins, this.receipts, suite)
  }
  clearSuiteCheckpoint(packageName: string, task: string) {
    if (this.checkpoints[packageName]?.task !== task) return
    this.saveSuiteCheckpoint(packageName, undefined)
  }
  applySuite(packageName: string, task: string, settings: Omit<PluginAccessSettings, 'revision'>) {
    const existing = this.suiteCheckpoint(packageName)
    if (existing) { if (existing.task === task) return; throw Error('Plugin access task is busy') }
    const before = this.get(packageName), receipt = this.receipt(packageName)
    const applied = { ...structuredClone(settings), revision: randomUUID() }
    this.persist({ ...this.plugins, [packageName]: applied }, this.receipts, { ...this.checkpoints, [packageName]: {
      task, ...(before ? { before } : {}), ...(receipt ? { receipt } : {}), appliedRevision: applied.revision,
    } })
  }
  restoreSuite(packageName: string, task: string): boolean {
    const checkpoint = this.suiteCheckpoint(packageName)
    if (!checkpoint || checkpoint.task !== task) return true
    if (this.get(packageName)?.revision !== checkpoint.appliedRevision) return false
    const plugins = { ...this.plugins }, receipts = { ...this.receipts }, checkpoints = { ...this.checkpoints }
    if (checkpoint.before) plugins[packageName] = checkpoint.before
    else delete plugins[packageName]
    if (checkpoint.receipt) receipts[packageName] = checkpoint.receipt
    else delete receipts[packageName]
    delete checkpoints[packageName]
    this.persist(plugins, receipts, checkpoints)
    return true
  }
  get(packageName: string) { const row = Object.hasOwn(this.plugins, packageName) ? this.plugins[packageName] : undefined; return row ? structuredClone(row) : undefined }
  list() { return structuredClone(this.plugins) }
  commitContribution(packageName: string, settings: Omit<PluginAccessSettings, 'revision'> | undefined, contribution: ContributionReceipt) {
    if (settings) this.save(packageName, settings, contribution)
    else { const plugins = { ...this.plugins }; delete plugins[packageName]; this.persist(plugins, { ...this.receipts, [packageName]: contribution }) }
  }
  receipt(packageName: string) { const receipt = Object.hasOwn(this.receipts, packageName) ? this.receipts[packageName] : undefined; return receipt ? { ...receipt } : undefined }
  save(packageName: string, settings: Omit<PluginAccessSettings, 'revision'>, contribution?: ContributionReceipt) {
    const prior = this.get(packageName)
    const receipts = contribution ? { ...this.receipts, [packageName]: contribution } : this.receipts
    if (prior && JSON.stringify({ ...prior, revision: undefined }) === JSON.stringify(settings)) { if (contribution) this.persist(this.plugins, receipts); return }
    this.persist({ ...this.plugins, [packageName]: { ...structuredClone(settings), revision: randomUUID() } }, receipts)
  }
  remove(packageName: string) { const plugins = { ...this.plugins }; delete plugins[packageName]; this.persist(plugins) }
  private persist(plugins: Record<string, PluginAccessSettings>, receipts = this.receipts, checkpoints = this.checkpoints) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try { writeFileSync(temporary, JSON.stringify({ schema: 1, plugins, receipts, suite: checkpoints }), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path); this.plugins = plugins; this.receipts = receipts; this.checkpoints = checkpoints }
    finally { rmSync(temporary, { force: true }) }
  }
}
