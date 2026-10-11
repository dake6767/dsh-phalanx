import { createHash, randomUUID } from 'node:crypto'
import type { Stats } from 'node:fs'
import { chmod, cp, lstat, mkdir, readdir, readFile, readlink, rename, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { PreparedExecution } from '../domain/execution-preparation.js'

/** Prepared trees are private to the platform and mounted read-only only in execution containers. */
export class FileExecutionArtifacts {
  constructor(private readonly root: string) {}
  directory(id: string): string {
    if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid prepared execution identity')
    return join(this.root, id)
  }
  async stage(): Promise<{ directory: string }> {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const directory = join(this.root, '.stage-' + randomUUID())
    await mkdir(directory, { mode: 0o700 }); return { directory }
  }
  async seed(stage: { directory: string }, source: string): Promise<void> {
    await cp(source, stage.directory, { recursive: true, force: false, verbatimSymlinks: true })
    await this.walk(stage.directory, async (path, info) => {
      if (info.isDirectory()) await chmod(path, 0o700)
      else if (info.isFile()) await chmod(path, 0o600 | (info.mode & 0o111))
    })
  }
  async publish(stage: { directory: string }, version: string, identity: string, log: string): Promise<PreparedExecution> {
    const digest = createHash('sha256')
    await this.walk(stage.directory, async (path, info) => {
      digest.update(JSON.stringify([relative(stage.directory, path), info.isDirectory() ? 'directory' : info.isSymbolicLink() ? 'link' : 'file', info.mode & 0o111]))
      if (info.isFile()) { digest.update(await readFile(path)); await chmod(path, info.mode & 0o111 ? 0o555 : 0o444) }
      else if (info.isSymbolicLink()) digest.update(await readlink(path))
      else if (info.isDirectory()) await chmod(path, 0o555)
      else throw new Error('Unexpected prepared artifact entry')
    })
    const hash = digest.digest('hex'), id = createHash('sha256').update(JSON.stringify([identity, hash, randomUUID()])).digest('hex')
    await rename(stage.directory, this.directory(id)); return { id, version, hash, log }
  }
  async discard(stage: { directory: string }): Promise<void> { await this.remove(stage.directory) }
  async collect(retained: readonly string[]): Promise<void> {
    let entries: string[]
    try { entries = await readdir(this.root) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    for (const id of entries) if (!retained.includes(id) && (/^[a-f0-9]{64}$/u.test(id) || id.startsWith('.stage-'))) await this.remove(join(this.root, id))
  }
  private async walk(path: string, visit: (path: string, info: Stats) => Promise<void>): Promise<void> {
    const info = await lstat(path)
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await this.walk(join(path, name), visit)
    await visit(path, info)
  }
  private async remove(path: string): Promise<void> {
    try {
      const info = await lstat(path)
      if (info.isDirectory()) {
        await chmod(path, 0o700)
        for (const name of await readdir(path)) await this.remove(join(path, name))
      }
      await rm(path, { recursive: true, force: true })
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}
