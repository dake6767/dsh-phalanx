import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SkillImportIntent, SkillImportIntentPort } from '../ports/skill-import-intent.js'

export class FileSkillImportIntent implements SkillImportIntentPort {
  private intent: SkillImportIntent | undefined
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const value = JSON.parse(readFileSync(path, 'utf8')) as { schema?: number, intent?: SkillImportIntent }
    const intent = value.intent
    if (value.schema !== 1 || !intent || typeof intent.token !== 'string' || !intent.actor || typeof intent.actor.username !== 'string' || typeof intent.actor.spaceId !== 'string' || !Number.isInteger(intent.actor.sessionEpoch)
      || !Array.isArray(intent.skills) || !Array.isArray(intent.packs) || intent.skills.some(skill => !skill || typeof skill.name !== 'string' || !/^[a-f0-9]{64}$/u.test(skill.hash))
      || intent.packs.some(pack => !pack || typeof pack.name !== 'string' || !Array.isArray(pack.skills) || pack.note && !/^[a-f0-9]{64}$/u.test(pack.note.hash))) throw new Error('Invalid skill import intent')
    this.intent = intent
  }
  get(): SkillImportIntent | undefined { return this.intent ? structuredClone(this.intent) : undefined }
  save(intent: SkillImportIntent): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temporary = `${this.path}.${randomUUID()}`
    try { writeFileSync(temporary, JSON.stringify({ schema: 1, intent }), { mode: 0o600, flag: 'wx' }); renameSync(temporary, this.path); this.intent = structuredClone(intent) }
    finally { rmSync(temporary, { force: true }) }
  }
  clear(): void { rmSync(this.path, { force: true }); this.intent = undefined }
}
