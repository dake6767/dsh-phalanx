import { assertPluginGroupConfiguration } from '../domain/plugin-group-configuration.js'
import type { ContributionReceipt } from '../domain/contribution-receipt.js'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PluginGroupConfigurationPort } from '../ports/managed-plugins.js'

/** Durable grants, independent from account storage; startup removes retired group keys. */
export class FilePluginGrants implements PluginGroupConfigurationPort {
  private receipts: Record<string, Record<string, ContributionReceipt>> = {}
  private groups: Record<string, readonly string[]> = {}
  private preinstalledGroups: Record<string, readonly string[]> = {}
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schema?: number, groups?: Record<string, unknown>, preinstalls?: Record<string, string[]>, receipts?: Record<string, Record<string, ContributionReceipt>> }
    if (value.schema !== 1 || !value.groups || Array.isArray(value.groups) || Object.values(value.groups).some(names => !Array.isArray(names) || names.some(name => typeof name !== 'string'))) throw new Error('Invalid plugin grants')
    const native = value.preinstalls ?? {}
    if (typeof native !== 'object' || Array.isArray(native) || Object.values(native).some(names => !Array.isArray(names) || names.some(name => typeof name !== 'string'))) throw new Error('Invalid plugin preinstalls')
    for (const [id, names] of Object.entries(value.groups)) assertPluginGroupConfiguration(names as string[], native[id] ?? [])
    this.groups = value.groups as Record<string, string[]>; this.receipts = value.receipts ?? {}; this.preinstalledGroups = native
  }
  contributionReceipt(groupId: string, packageName: string) { return this.receipts[groupId]?.[packageName] }
  grantContribution(groupId: string, packageName: string, receipt: ContributionReceipt): void {
    assertPluginGroupConfiguration([...this.get(groupId), packageName], this.preinstalls(groupId))
    this.save({ ...this.groups, [groupId]: [...new Set([...this.get(groupId), packageName])].sort() }, { ...this.receipts, [groupId]: { ...this.receipts[groupId], [packageName]: receipt } })
  }
  preinstalls(groupId: string): readonly string[] { return [...(Object.hasOwn(this.preinstalledGroups, groupId) ? this.preinstalledGroups[groupId]! : [])] }
  configure(groupId: string, controlled: readonly string[], preinstalled: readonly string[]): void {
    assertPluginGroupConfiguration(controlled, preinstalled)
    this.save({ ...this.groups, [groupId]: [...new Set(controlled)].sort() }, this.receipts, { ...this.preinstalledGroups, [groupId]: [...new Set(preinstalled)].sort() })
  }
  get(groupId: string): readonly string[] { return [...(this.groups[groupId] ?? [])] }
  set(groupId: string, packages: readonly string[]): void { this.configure(groupId, packages, this.preinstalls(groupId)) }
  remove(groupId: string): void { this.retainGroups([...new Set([...Object.keys(this.groups), ...Object.keys(this.preinstalledGroups), ...Object.keys(this.receipts)])].filter(id => id !== groupId)) }
  retainGroups(groupIds: readonly string[]): void {
    const retained = new Set(groupIds)
    if ([...Object.keys(this.groups), ...Object.keys(this.preinstalledGroups), ...Object.keys(this.receipts)].every(id => retained.has(id))) return
    this.save(Object.fromEntries(Object.entries(this.groups).filter(([id]) => retained.has(id))),
      Object.fromEntries(Object.entries(this.receipts).filter(([id]) => retained.has(id))), Object.fromEntries(Object.entries(this.preinstalledGroups).filter(([id]) => retained.has(id))))
  }
  private save(next: Record<string, readonly string[]>, receipts = this.receipts, preinstalls = this.preinstalledGroups): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, groups: next, receipts, preinstalls }), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.path); this.groups = next; this.receipts = receipts; this.preinstalledGroups = preinstalls
    } finally { rmSync(temporary, { force: true }) }
  }
}
