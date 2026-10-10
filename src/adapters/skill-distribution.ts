import { createHash, randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readlink, readdir, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { SkillDistributionPort } from '../ports/member-skills.js'

/** The parent remains mounted; only a platform-owned relative live pointer is replaced. */
export class FileSkillDistribution implements SkillDistributionPort {
  constructor(private readonly root: string, private readonly artifacts: { directory(hash: string): string }) {}
  directory(spaceId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(spaceId)) throw new Error('Invalid member skill identity')
    return join(this.root, spaceId)
  }
  async synchronize(members: readonly { readonly spaceId: string, readonly skills: readonly LibrarySkill[] }[]): Promise<void> {
    for (const member of members) await this.publish(member.spaceId, member.skills)
    const retained = new Set(members.map(member => member.spaceId))
    for (const id of await this.entries(this.root)) if (!retained.has(id)) await this.remove(join(this.root, id))
  }
  private async publish(spaceId: string, skills: readonly LibrarySkill[]): Promise<void> {
    const parent = this.directory(spaceId)
    const identity = JSON.stringify(skills.map(skill => [skill.name, skill.hash]).sort())
    const generation = `generation-${createHash('sha256').update(identity).digest('hex')}`
    try { if (await readlink(join(parent, 'live')) === generation) { await this.collect(parent, generation); return } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await mkdir(parent, { recursive: true, mode: 0o700 })
    const next = join(parent, `.stage-${randomUUID()}`), pointer = join(parent, `next-${randomUUID()}`)
    try {
      await mkdir(next, { mode: 0o700 })
      for (const skill of skills) {
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(skill.name)) throw new Error('Invalid distributed skill name')
        await cp(this.artifacts.directory(skill.hash), join(next, skill.name), { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
      }
      await this.permissions(next, 0o555)
      await this.remove(join(parent, generation))
      await rename(next, join(parent, generation))
      await symlink(generation, pointer)
      await rename(pointer, join(parent, 'live'))
      await this.collect(parent, generation)
    } finally {
      await rm(pointer, { force: true }); await this.remove(next)
    }
  }
  private async collect(parent: string, retained: string): Promise<void> {
    for (const entry of await this.entries(parent)) if (entry !== retained && /^(?:generation-|next-|\.stage-)/u.test(entry)) await this.remove(join(parent, entry))
  }
  private async entries(path: string): Promise<string[]> {
    try { return await readdir(path) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
  }
  private async permissions(path: string, mode: number): Promise<void> {
    const info = await lstat(path)
    if (!info.isDirectory()) { if (!info.isFile()) throw new Error('Unexpected skill projection entry'); return }
    await chmod(path, mode)
    for (const entry of await readdir(path)) await this.permissions(join(path, entry), mode)
  }
  private async remove(path: string): Promise<void> {
    try {
      if ((await lstat(path)).isDirectory()) {
        await chmod(path, 0o700)
        for (const entry of await readdir(path)) await this.remove(join(path, entry))
      }
      await rm(path, { recursive: true, force: true })
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}
