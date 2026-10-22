import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { PluginInstallation, PluginInstallationsPort } from '../ports/plugin-installations.js'

/** Successful delivery history stays outside every member reset carrier. */
export class FilePluginInstallations implements PluginInstallationsPort {
  private spaces: Record<string, readonly PluginInstallation[]> = {}
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schema?: number, spaces?: Record<string, PluginInstallation[]> }
    if (value.schema !== 1 || !value.spaces || typeof value.spaces !== 'object' || Array.isArray(value.spaces)
      || Object.values(value.spaces).some(rows => !Array.isArray(rows) || rows.some(row => !row || typeof row.packageName !== 'string' || typeof row.version !== 'string' || !['selected', 'preinstall'].includes(row.source)))) throw Error('Invalid plugin installation history')
    this.spaces = value.spaces; chmodSync(path, 0o600)
  }
  get(spaceId: string): readonly PluginInstallation[] { return structuredClone(Object.hasOwn(this.spaces, spaceId) ? this.spaces[spaceId]! : []) }
  save(spaceId: string, record: PluginInstallation): void {
    const next = { ...this.spaces, [spaceId]: [...this.get(spaceId).filter(row => row.packageName !== record.packageName), { ...record }].sort((a, b) => a.packageName.localeCompare(b.packageName)) }
    this.commit(next)
  }
  clearPreinstalls(spaceId: string): void {
    const previous = this.get(spaceId), retained = previous.filter(row => row.source !== 'preinstall')
    if (retained.length !== previous.length) this.commit({ ...this.spaces, [spaceId]: retained })
  }
  private commit(next: Record<string, readonly PluginInstallation[]>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try { writeFileSync(temporary, JSON.stringify({ schema: 1, spaces: next }), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path); this.spaces = next }
    finally { rmSync(temporary, { force: true }) }
  }
}
