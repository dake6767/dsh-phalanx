import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { SkillLibraryStorePort } from '../ports/skill-library.js'

/** Independent library carrier; an older installation starts with no skills. */
export class FileSkillLibraryStore implements SkillLibraryStorePort {
  private rows: readonly LibrarySkill[] = []
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { schema?: number, skills?: LibrarySkill[] }
    if (stored.schema !== 1 || !Array.isArray(stored.skills)) throw new Error('Invalid skill library storage')
    const names = new Set<string>()
    for (const row of stored.skills) {
      if (!row || typeof row.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.name) || names.has(row.name)
        || typeof row.description !== 'string' || !row.description.length || !/^[a-f0-9]{64}$/u.test(row.hash)
        || !Number.isFinite(row.importedAt) || typeof row.published !== 'boolean' || (row.conflict !== undefined && typeof row.conflict !== 'boolean')) throw new Error('Invalid skill library record')
      names.add(row.name)
    }
    this.rows = stored.skills; chmodSync(path, 0o600)
  }
  list(): readonly LibrarySkill[] { return structuredClone(this.rows) }
  save(skill: LibrarySkill): void { this.persist([...this.rows.filter(row => row.name !== skill.name), skill]) }
  remove(name: string): void { this.persist(this.rows.filter(row => row.name !== name)) }
  private persist(next: readonly LibrarySkill[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, skills: next }), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.path); this.rows = structuredClone(next)
    } finally { rmSync(temporary, { force: true }) }
  }
}
