import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SkillPack } from '../domain/skill-pack.js'
import type { SkillPackStorePort } from '../ports/skill-packs.js'

/** Independent library carrier; an older installation starts with no packs. */
export class FileSkillPackStore implements SkillPackStorePort {
  private rows: readonly SkillPack[] = []
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { schema?: number, packs?: SkillPack[] }
    if (stored.schema !== 1 || !Array.isArray(stored.packs)) throw new Error('Invalid pack library storage')
    const names = new Set<string>()
    for (const row of stored.packs) {
      if (!row || typeof row.name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.name) || names.has(row.name)
        || typeof row.description !== 'string' || !row.description.length || typeof row.instructions !== 'string' || typeof row.published !== 'boolean'
        || !Array.isArray(row.skills) || row.skills.some(name => typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name))
        || row.renamedFrom !== undefined && (typeof row.renamedFrom !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(row.renamedFrom))
        || row.removing !== undefined && (!Array.isArray(row.removing) || row.removing.some(name => typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(name)))
        || row.suiteOrigin !== undefined && (typeof row.suiteOrigin !== 'string' || !row.suiteOrigin.startsWith('suite:'))
        || row.note && (row.note.name !== row.name || !/^[a-f0-9]{64}$/u.test(row.note.hash) || typeof row.note.description !== 'string' || !Number.isFinite(row.note.importedAt))) throw new Error('Invalid skill pack record')
      names.add(row.name)
    }
    this.rows = stored.packs; chmodSync(path, 0o600)
  }
  list(): readonly SkillPack[] { return structuredClone(this.rows) }
  save(pack: SkillPack): void { this.persist([...this.rows.filter(row => row.name !== pack.name), pack]) }
  remove(name: string): void { this.persist(this.rows.filter(row => row.name !== name)) }
  private persist(next: readonly SkillPack[]): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify({ schema: 1, packs: next }), { mode: 0o600, flag: 'wx' })
      renameSync(temporary, this.path); this.rows = structuredClone(next)
    } finally { rmSync(temporary, { force: true }) }
  }
}
