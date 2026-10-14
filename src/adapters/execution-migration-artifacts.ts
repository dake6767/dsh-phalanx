import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { FileExecutionArtifacts } from './execution-artifacts.js'

/** Inspect existing private output to preserve the old execution search order during migration. */
export class ExecutionMigrationArtifacts {
  constructor(private readonly artifacts: FileExecutionArtifacts, private readonly canDiscard: () => boolean) {}
  collect(retained: readonly string[]): Promise<void> { return this.canDiscard() ? this.artifacts.collect(retained) : Promise.resolve() }
  async pathDirectories(id?: string): Promise<readonly string[]> {
    const paths: string[] = []
    if (id) for (const path of ['.venv/bin', 'node_modules/.bin', 'bin', '.']) {
      const directory = join(this.artifacts.directory(id), path)
      try {
        for (const name of await readdir(directory)) {
          const info = await stat(join(directory, name))
          if (info.isFile() && (info.mode & 0o111)) { paths.push(path); break }
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    // No successful old installation: keep the generated definition visible for administrator repair.
    return paths.length ? paths : ['bin']
  }
}
