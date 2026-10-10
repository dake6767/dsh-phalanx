import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SkillArtifactsPort } from '../ports/skill-library.js'
import { SKILL_MAX_BYTES, SkillArchiveError, type SkillContents, type UploadedSkill } from '../domain/skill-library.js'
import { inspectSkillArchive } from './skill-archive.js'

/** Content-addressed originals and safe extracted files. Never executes skill code. */
export class FileSkillArtifacts implements SkillArtifactsPort {
  constructor(private readonly root: string, private readonly bundled: readonly string[]) {}
  newToken(): string { return randomUUID() }
  directory(hash: string): string { return join(this.path(hash), 'files') }
  original(hash: string): string { return join(this.path(hash), 'original.zip') }
  async accept(content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<UploadedSkill> {
    let length = 0; const chunks: Buffer[] = []
    const iterator = content[Symbol.asyncIterator]()
    while (true) {
      const next = await this.next(iterator, signal)
      if (next.done) break
      const chunk = next.value
      signal.throwIfAborted(); length += chunk.length
      if (length > SKILL_MAX_BYTES) throw new SkillArchiveError('skill-upload-too-large', 'The compressed skill must be at most 20 MB.')
      chunks.push(Buffer.from(chunk))
    }
    signal.throwIfAborted()
    const bytes = Buffer.concat(chunks), inspected = await inspectSkillArchive(bytes, this.bundled)
    const hash = createHash('sha256').update(bytes).digest('hex'), target = this.path(hash)
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    try { await lstat(target) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const staging = join(this.root, `.stage-${randomUUID()}`)
      try {
        await mkdir(join(staging, 'files'), { recursive: true, mode: 0o700 })
        await writeFile(join(staging, 'original.zip'), bytes, { mode: 0o400, flag: 'wx' })
        for (const file of inspected.files) {
          signal.throwIfAborted()
          const path = join(staging, 'files', file.path)
          await mkdir(dirname(path), { recursive: true, mode: 0o700 })
          await writeFile(path, file.bytes, { mode: 0o555, flag: 'wx' })
        }
        await this.permissions(join(staging, 'files'), 0o555)
        signal.throwIfAborted(); await rename(staging, target)
      } finally { await this.remove(staging) }
    }
    return { name: inspected.name, description: inspected.description, hash, markdown: inspected.markdown, files: inspected.files.map(file => file.path) }
  }
  async read(hash: string): Promise<SkillContents> {
    const root = this.directory(hash), files: string[] = []
    const walk = async (relative: string): Promise<void> => {
      for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
        const path = relative ? `${relative}/${entry.name}` : entry.name
        if (entry.isDirectory()) await walk(path)
        else if (entry.isFile()) files.push(path)
        else throw new Error('Unexpected skill artifact entry')
      }
    }
    await walk('')
    return { markdown: await readFile(join(root, 'SKILL.md'), 'utf8'), files: files.sort() }
  }
  async collect(retained: readonly string[]): Promise<void> {
    let entries: string[]
    try { entries = await readdir(this.root) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    const keep = new Set(retained)
    for (const entry of entries) if (!keep.has(entry)) await this.remove(join(this.root, entry))
  }
  private async next(iterator: AsyncIterator<Uint8Array>, signal: AbortSignal): Promise<IteratorResult<Uint8Array>> {
    signal.throwIfAborted()
    let abort!: () => void
    const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }) })
    try { return await Promise.race([iterator.next(), cancelled]) }
    finally { signal.removeEventListener('abort', abort) }
  }
  private path(hash: string): string {
    if (!/^[a-f0-9]{64}$/u.test(hash)) throw new Error('Invalid skill content identity')
    return join(this.root, hash)
  }
  private async permissions(path: string, mode: number): Promise<void> {
    const info = await lstat(path)
    if (!info.isDirectory()) return
    await chmod(path, mode)
    for (const entry of await readdir(path)) await this.permissions(join(path, entry), mode)
  }
  private async remove(path: string): Promise<void> {
    try { await this.permissions(path, 0o700) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await rm(path, { recursive: true, force: true })
  }
}
