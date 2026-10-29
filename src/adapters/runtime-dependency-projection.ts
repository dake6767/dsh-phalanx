import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeDependencyVersion } from '../domain/runtime-dependency.js'
import { preparePythonLibraryEnvironment } from './python-library-environment.js'

/** A fixed PATH directory follows an atomic live pointer; older generations protect running member commands. */
export class FileRuntimeDependencyProjection {
  private pending: Promise<unknown> = Promise.resolve()
  constructor(
    private readonly root: string,
    private readonly versions: (spaceId: string) => Promise<readonly RuntimeDependencyVersion[]>,
    private readonly inUse: (spaceId: string) => Promise<boolean> = async () => true,
    private readonly mountedRoot?: string,
    private readonly maySynchronize: (spaceId: string) => Promise<boolean> = async () => true,
  ) {}
  async identity(spaceId: string, prepared?: readonly RuntimeDependencyVersion[]): Promise<unknown> {
    const versions = prepared ?? (await this.versions(spaceId))
    return versions.some(version => version.python)
      ? ['python-venv-v1', versions.map(version => [version.id, version.python?.name])]
      : versions.map(version => version.id)
  }
  async apply(): Promise<void> {}
  async prepare(spaceId: string, versions?: readonly RuntimeDependencyVersion[]): Promise<void> {
    if (!versions && !(await this.maySynchronize(spaceId))) return
    const selected = versions ?? (await this.versions(spaceId))
    return this.serial(() => this.publish(spaceId, selected))
  }
  retained(): Promise<readonly string[]> {
    return this.serial(() => this.collect())
  }
  removeMember(spaceId: string, remove: () => Promise<void>): Promise<void> {
    return this.serial(async () => {
      if (!(await this.inUse(spaceId))) await remove()
    })
  }
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.pending.then(run)
    this.pending = result.catch(() => {})
    return result
  }
  private async publish(spaceId: string, versions: readonly RuntimeDependencyVersion[]): Promise<void> {
    const directory = join(this.root, spaceId, 'dependencies')
    const generation =
      'generation-' +
      createHash('sha256')
        .update(JSON.stringify(await this.identity(spaceId, versions)))
        .digest('hex')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    try {
      if ((await readlink(join(directory, 'live'))) === generation) return
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const stage = join(directory, '.stage-' + randomUUID()),
      pointer = join(directory, '.next-' + randomUUID())
    try {
      await mkdir(stage, { mode: 0o700 })
      for (const version of versions.filter(version => !version.python))
        for (const command of version.commands) {
          const relative = version.commandPaths[command]
          if (!relative) throw new Error('Prepared dependency command path is missing')
          await symlink(`${version.mountedPath}/${relative}`, join(stage, command))
        }
      await preparePythonLibraryEnvironment(stage, this.mountedRoot ? `${this.mountedRoot}/dependencies/${generation}` : join(directory, generation), versions)
      await writeFile(stage + '.json', JSON.stringify(versions.map(version => version.id)), { mode: 0o400 })
      const target = join(directory, generation)
      await rename(stage + '.json', target + '.json')
      try {
        await rename(stage, target)
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
      await symlink(generation, pointer)
      await rename(pointer, join(directory, 'live'))
    } finally {
      await rm(stage, { recursive: true, force: true })
      await rm(stage + '.json', { force: true })
      await rm(pointer, { force: true })
    }
  }
  private async collect(): Promise<readonly string[]> {
    const ids = new Set<string>()
    for (const spaceId of await this.entries(this.root)) {
      const directory = join(this.root, spaceId, 'dependencies')
      let live: string
      try {
        live = await readlink(join(directory, 'live'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      for (const generation of await this.entries(directory))
        if (/^generation-[a-f0-9]{64}$/u.test(generation)) {
          if (generation !== live && !(await this.inUse(spaceId))) {
            await rm(join(directory, generation), { recursive: true, force: true })
            await rm(join(directory, generation + '.json'), { force: true })
            continue
          }
          const retained = JSON.parse(await readFile(join(directory, generation + '.json'), 'utf8')) as unknown
          if (!Array.isArray(retained) || retained.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)))
            throw new Error('Invalid member dependency retention record')
          for (const id of retained) ids.add(id)
        }
    }
    return [...ids]
  }
  private async entries(path: string): Promise<string[]> {
    try {
      return await readdir(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}
