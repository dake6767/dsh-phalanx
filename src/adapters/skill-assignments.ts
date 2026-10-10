import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SkillAssignmentsPort } from '../ports/member-skills.js'

/** Separate files for group grants and immutable-space member selections. */
export class FileSkillAssignments implements SkillAssignmentsPort {
  private rows: Readonly<Record<string, readonly string[]>> = {}
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schema?: number, assignments?: Record<string, unknown> }
    if (value.schema !== 1 || !value.assignments || typeof value.assignments !== 'object' || Array.isArray(value.assignments)
      || Object.values(value.assignments).some(row => !Array.isArray(row) || row.some(name => typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)))) throw new Error('Invalid skill assignments')
    this.rows = value.assignments as Record<string, string[]>
  }
  get(id: string): readonly string[] { return Object.hasOwn(this.rows, id) ? [...this.rows[id]!] : [] }
  set(id: string, names: readonly string[]): void { this.save({ ...this.rows, [id]: [...new Set(names)].sort() }) }
  retain(ids: readonly string[], names: readonly string[]): void {
    const retained = new Set(ids), allowed = new Set(names)
    this.save(Object.fromEntries(Object.entries(this.rows).filter(([id]) => retained.has(id)).map(([id, values]) => [id, values.filter(name => allowed.has(name))])))
  }
  private save(next: Readonly<Record<string, readonly string[]>>): void {
    if (JSON.stringify(next) === JSON.stringify(this.rows)) return
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try { writeFileSync(temporary, JSON.stringify({ schema: 1, assignments: next }), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path); this.rows = next }
    finally { rmSync(temporary, { force: true }) }
  }
}
