import { createHash, randomUUID } from 'node:crypto'
import { chmod, cp, lstat, mkdir, readlink, readdir, rename, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import type { LibrarySkill } from '../domain/skill-library.js'
import type { SkillDistributionPort } from '../ports/member-skills.js'

interface SkillProjection { identity(spaceId: string): unknown, prepare(spaceId: string): Promise<void>, apply(spaceId: string, root: string): Promise<void>, removeMember?(spaceId: string, remove: () => Promise<void>): Promise<void> }

/** The parent remains mounted; only a platform-owned relative live pointer is replaced. */
export class FileSkillDistribution implements SkillDistributionPort {
  private readonly projections: readonly SkillProjection[]
  constructor(private readonly root: string, private readonly artifacts: { directory(hash: string): string },
    projection?: SkillProjection | readonly SkillProjection[]) { this.projections = projection ? (Array.isArray(projection) ? projection : [projection as SkillProjection]) : [] }
  directory(spaceId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(spaceId)) throw new Error('Invalid member skill identity')
    return join(this.root, spaceId)
  }
  async snapshot(members: readonly { readonly spaceId: string, readonly skills: readonly LibrarySkill[] }[]) {
    const outputs = await Promise.all(members.map(async member => {
      const root = this.directory(member.spaceId)
      return await Promise.all(['live', 'commands/live', 'dependencies/live'].map(async name => {
        try {
          const target = await readlink(join(root, name)), info = await lstat(join(root, name, '..', target), { bigint: true })
          return [name, target, String(info.ino), String(info.mtimeNs)]
        } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [name, 'missing']; throw error }
      }))
    }))
    return { inputs: members.map(member => [member, this.projections.map(projection => projection.identity(member.spaceId))]), outputs: [await this.entries(this.root), outputs] }
  }
  async synchronize(members: readonly { readonly spaceId: string, readonly skills: readonly LibrarySkill[] }[]): Promise<void> {
    for (const member of members) await this.publish(member.spaceId, member.skills)
    const retained = new Set(members.map(member => member.spaceId))
    for (const id of await this.entries(this.root)) if (!retained.has(id)) {
      const remove = this.projections.reduce<() => Promise<void>>((next, projection) => projection.removeMember ? () => projection.removeMember!(id, next) : next, () => this.remove(join(this.root, id)))
      await remove()
    }
  }
  private async publish(spaceId: string, skills: readonly LibrarySkill[]): Promise<void> {
    const parent = this.directory(spaceId)
    for (const projection of this.projections) await projection.prepare(spaceId)
    const identity = JSON.stringify([skills.map(skill => [skill.name, skill.hash]).sort(), this.projections.map(projection => projection.identity(spaceId))])
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
      for (const projection of this.projections) await projection.apply(spaceId, next)
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
