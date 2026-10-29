import { createHash, randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { executionForwarderSource, executionStub } from './execution-forwarder.js'

export interface ExecutionProjectionCommand {
  readonly owner: string
  readonly skill: string
  readonly command: string
  readonly source?: string
  readonly memberPath?: string
}
/** Lives inside the already mounted member projection, so grants can hot-update its live command directory. */
export class FileExecutionProjection {
  constructor(
    private readonly root: string,
    private readonly mountedRoot: string | undefined,
    private readonly commands: (spaceId: string) => Promise<readonly ExecutionProjectionCommand[]>,
  ) {}
  async identity(spaceId: string): Promise<unknown> {
    return [await this.commands(spaceId), executionForwarderSource(), executionStub.toString()]
  }
  async prepare(spaceId: string): Promise<void> {
    const commands = await this.commands(spaceId),
      directory = join(this.root, spaceId, 'commands')
    const identity = createHash('sha256').update(JSON.stringify(commands)).update(executionForwarderSource()).update(executionStub.toString()).digest('hex')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const generation = 'generation-' + identity,
      destination = join(directory, generation)
    try {
      if ((await readlink(join(directory, 'live'))) === generation) return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const stage = join(directory, '.stage-' + randomUUID()),
      pointer = join(directory, '.next-' + randomUUID())
    const dispatch = join(this.mountedRoot ?? join(this.root, spaceId), 'commands', 'dispatch.mjs')
    try {
      await mkdir(stage, { mode: 0o700 })
      const program = join(directory, '.dispatch-' + randomUUID())
      try {
        await writeFile(program, executionForwarderSource(), { mode: 0o500, flag: 'wx' })
        await rename(program, join(directory, 'dispatch.mjs'))
      } finally {
        await rm(program, { force: true })
      }
      for (const row of commands.filter(row => !row.command.includes('/')))
        await writeFile(join(stage, row.command), executionStub(dispatch, row.owner, row.command), { mode: 0o500 })
      await rm(destination, { recursive: true, force: true })
      await rename(stage, destination)
      await symlink(generation, pointer)
      await rename(pointer, join(directory, 'live'))
    } finally {
      await rm(stage, { recursive: true, force: true })
      await rm(pointer, { force: true })
    }
  }
  private async aliasDirectory(skill: string, memberPath: string): Promise<void> {
    let directory = skill
    for (const segment of ['', ...memberPath.split('/').slice(0, -1)]) {
      if (segment) {
        directory = join(directory, segment)
        try {
          await mkdir(directory, { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
      }
      if (!(await lstat(directory)).isDirectory()) throw new Error('Unexpected execution alias directory')
      await chmod(directory, 0o700)
    }
  }
  async apply(spaceId: string, root: string): Promise<void> {
    const dispatch = join(this.mountedRoot ?? join(this.root, spaceId), 'commands', 'dispatch.mjs')
    for (const row of (await this.commands(spaceId)).filter(row => (row.memberPath ?? row.command).includes('/'))) {
      const target = join(root, row.skill, row.memberPath ?? row.command)
      if (row.source) await this.aliasDirectory(join(root, row.skill), row.memberPath ?? row.command)
      try {
        await chmod(target, 0o700)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (!row.source) continue
      }
      await chmod(dirname(target), 0o700)
      await writeFile(target, executionStub(dispatch, row.owner, row.command, row.memberPath), { mode: 0o500 })
      await chmod(target, 0o500)
    }
  }
}
