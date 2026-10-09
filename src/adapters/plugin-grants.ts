import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PluginGrantsPort } from '../ports/managed-plugins.js'

/** Durable grants, independent from account storage; startup removes retired group keys. */
export class FilePluginGrants implements PluginGrantsPort {
  private groups: Record<string, readonly string[]> = {}
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schema?: number, groups?: Record<string, unknown> }
    if (value.schema !== 1 || !value.groups || Array.isArray(value.groups) || Object.values(value.groups).some(names => !Array.isArray(names) || names.some(name => typeof name !== 'string'))) throw new Error('Invalid plugin grants')
    this.groups = value.groups as Record<string, string[]>
  }
  get(groupId: string): readonly string[] { return [...(this.groups[groupId] ?? [])] }
  set(groupId: string, packages: readonly string[]): void { this.save({ ...this.groups, [groupId]: [...new Set(packages)].sort() }) }
  remove(groupId: string): void { this.retainGroups(Object.keys(this.groups).filter(id => id !== groupId)) }
  retainGroups(groupIds: readonly string[]): void {
    const retained = new Set(groupIds)
    if (Object.keys(this.groups).every(id => retained.has(id))) return
    this.save(Object.fromEntries(Object.entries(this.groups).filter(([id]) => retained.has(id))))
  }
  private save(next: Record<string, readonly string[]>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, groups: next }), { flag: 'wx', mode: 0o600 })
      renameSync(temporary, this.path); this.groups = next
    } finally { rmSync(temporary, { force: true }) }
  }
}
