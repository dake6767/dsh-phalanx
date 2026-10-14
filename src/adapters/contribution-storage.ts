import { readSkillUpload } from './skill-upload-stream.js'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MemberContribution } from '../domain/member-contribution.js'
import type { ContributionStore, ContributionArtifacts, ContributionAdoptionIntent } from '../ports/member-contributions.js'
import { SKILL_MAX_BYTES } from '../domain/skill-library.js'
import { inspectSkillArchive } from './skill-archive.js'

/** Pending artifacts never share the live library's collector or member projection. */
export class FileContributionStore implements ContributionStore {
  private adoption: ContributionAdoptionIntent | undefined
  private rows: readonly MemberContribution[] = []
  constructor(private readonly path: string) {
    if (!existsSync(path)) return
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { schema: number, contributions: MemberContribution[], adoption?: ContributionAdoptionIntent }
    if (stored.schema !== 1 || !Array.isArray(stored.contributions)) throw new Error('Invalid contribution storage')
    for (const row of stored.contributions) if (!row || typeof row.id !== 'string' || !/^[a-f0-9]{64}$/u.test(row.hash)
      || !['pending', 'adopted', 'declined', 'withdrawn'].includes(row.status) || !row.contributor?.spaceId || !Number.isFinite(row.updatedAt)) throw new Error('Invalid contribution record')
    this.adoption = stored.adoption
    this.rows = stored.contributions
  }
  intent(): ContributionAdoptionIntent | undefined { return this.adoption ? structuredClone(this.adoption) : undefined }
  begin(intent: ContributionAdoptionIntent): void { this.persist(this.rows, intent) }
  finish(rows: readonly MemberContribution[]): void { this.persist(rows, undefined) }
  list(): readonly MemberContribution[] { return structuredClone(this.rows) }
  save(row: MemberContribution): void { this.persist([...this.rows.filter(other => other.id !== row.id), row], this.adoption) }
  remove(id: string): void { this.persist(this.rows.filter(row => row.id !== id), this.adoption) }
  private persist(rows: readonly MemberContribution[], adoption: ContributionAdoptionIntent | undefined) {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 }); const staging = `${this.path}.${randomUUID()}`
    try { writeFileSync(staging, JSON.stringify({ schema: 1, contributions: rows, adoption }), { mode: 0o600, flag: 'wx' }); renameSync(staging, this.path); this.rows = structuredClone(rows); this.adoption = adoption }
    finally { rmSync(staging, { force: true }) }
  }
}
export class FileContributionArtifacts implements ContributionArtifacts {
  constructor(private readonly root: string, private readonly bundled: readonly string[]) {}
  async accept(content: AsyncIterable<Uint8Array>, signal: AbortSignal) {
    const bytes = await readSkillUpload(content, signal, SKILL_MAX_BYTES), inspected = await inspectSkillArchive(bytes, this.bundled)
    signal.throwIfAborted()
    const hash = createHash('sha256').update(bytes).digest('hex')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const staging = join(this.root, `${hash}.${randomUUID()}.tmp`)
    try { await writeFile(staging, bytes, { mode: 0o600, flag: 'wx' }); await rename(staging, this.path(hash)) }
    finally { await rm(staging, { force: true }) }
    return { name: inspected.name, description: inspected.description, hash, markdown: inspected.markdown, files: inspected.files.map(file => file.path) }
  }
  read(hash: string): Promise<Uint8Array> { return readFile(this.path(hash)) }
  async collect(retained: readonly string[]): Promise<void> {
    let names: string[]
    try { names = await readdir(this.root) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    const keep = new Set(retained.map(hash => `${hash}.zip`))
    for (const name of names) if (/^[a-f0-9]{64}\.zip$/u.test(name) && !keep.has(name)) await rm(join(this.root, name), { force: true })
  }
  newId(): string { return randomUUID() }
  private path(hash: string) { if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error('Invalid contribution artifact'); return join(this.root, `${hash}.zip`) }
}
