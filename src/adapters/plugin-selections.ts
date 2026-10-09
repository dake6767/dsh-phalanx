import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PluginSelectionsPort } from '../ports/plugin-selections.js'
export class FilePluginSelections implements PluginSelectionsPort {
  private spaces: Record<string, readonly string[]> = {}
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schema?: number, spaces?: Record<string, string[]> }
    if (value.schema !== 1 || !value.spaces || Array.isArray(value.spaces) || Object.values(value.spaces).some(names => !Array.isArray(names) || names.some(name => typeof name !== 'string'))) throw Error('Invalid plugin selections')
    this.spaces = value.spaces; chmodSync(path, 0o600)
  }
  get(spaceId: string): readonly string[] { return [...(this.spaces[spaceId] ?? [])] }
  set(spaceId: string, packages: readonly string[]): void { this.save({ ...this.spaces, [spaceId]: [...new Set(packages)].sort() }) }
  members(packageName: string): readonly string[] { return Object.entries(this.spaces).filter(([, names]) => names.includes(packageName)).map(([id]) => id) }
  removePackage(packageName: string): void {
    this.save(Object.fromEntries(Object.entries(this.spaces).map(([id, names]) => [id, names.filter(name => name !== packageName)])))
  }
  retainPackages(packageNames: readonly string[]): void {
    const allowed = new Set(packageNames)
    if (Object.values(this.spaces).every(names => names.every(name => allowed.has(name)))) return
    this.save(Object.fromEntries(Object.entries(this.spaces).map(([id, names]) => [id, names.filter(name => allowed.has(name))])))
  }
  private save(next: Record<string, readonly string[]>): void {
    const spaces = Object.fromEntries(Object.entries(next).filter(([, names]) => names.length))
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try { writeFileSync(temporary, JSON.stringify({ schema: 1, spaces }), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path); this.spaces = spaces }
    finally { rmSync(temporary, { force: true }) }
  }
}
