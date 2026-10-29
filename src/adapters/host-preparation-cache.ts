import { lstat, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'

/** Reuses a successful host projection while its inputs and owned outputs retain their identities. */
type PreparationPath = string | { path: string; shallow: true }
export class HostPreparationCache {
  private readonly tails = new Map<string, Promise<void>>()
  private readonly completed = new Map<string, { input: string; output: string; value: unknown }>()
  prepare<T>(
    key: string,
    input: unknown,
    sources: readonly PreparationPath[],
    outputs: readonly PreparationPath[],
    build: () => Promise<T>,
    reusable: (value: T) => boolean,
  ): Promise<T> {
    const task = (this.tails.get(key) ?? Promise.resolve()).then(async () => {
      const signature = JSON.stringify([input, await identities(sources)]),
        previous = this.completed.get(key)
      if (previous?.input === signature && previous.output === JSON.stringify(await identities(outputs))) return previous.value as T
      this.completed.delete(key)
      const value = await build()
      if (reusable(value)) this.completed.set(key, { input: signature, output: JSON.stringify(await identities(outputs)), value })
      return value
    })
    const tail = task.then(
      () => {},
      () => {},
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return task
  }
}
async function identities(paths: readonly PreparationPath[]): Promise<unknown[]> {
  return await Promise.all(
    paths.map(async entry => {
      const path = typeof entry === 'string' ? entry : entry.path
      try {
        const info = await lstat(path, { bigint: true })
        const own = [path, String(info.dev), String(info.ino), String(info.mode), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]
        if (typeof entry !== 'string' && entry.shallow) return own
        if (info.isSymbolicLink()) return [...own, await readlink(path)]
        return info.isDirectory() ? [...own, await identities((await readdir(path)).sort().map(name => join(path, name)))] : own
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [path, 'missing']
        throw error
      }
    }),
  )
}
