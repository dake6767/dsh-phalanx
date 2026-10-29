import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, readlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { assertPluginIdentity, type PreparedPlugin } from '../domain/plugin-library.js'
import type { ContributionPluginFilesPort } from '../ports/contribution-policy.js'
/** Hash the selected, checked package tree; never extract or evaluate an archive. */
export class FileContributionPluginFiles implements ContributionPluginFilesPort {
  constructor(private readonly root: string) {}
  async files(prepared: PreparedPlugin): Promise<Readonly<Record<string, string>>> {
    assertPluginIdentity(prepared)
    const preparation = prepared.preparationId ?? prepared.runtimeRevision
    if (!/^artifacts\/[a-f0-9]{128}$/u.test(prepared.artifact) || !/^[a-f0-9]{40}(?:-[a-f0-9-]{36})?$/u.test(preparation))
      throw Error('Invalid plugin artifact identity')
    const root = resolve(this.root, prepared.artifact, 'prepared', preparation, 'node_modules', prepared.packageName),
      hashes = new Map<string, string>()
    let size = 0
    const walk = async (directory: string, prefix: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix + entry.name,
          absolute = join(directory, entry.name)
        if (entry.isDirectory()) {
          await walk(absolute, path + '/')
          continue
        }
        if (hashes.size >= 10000 || (!entry.isFile() && !entry.isSymbolicLink())) throw Error('Invalid plugin artifact entry')
        size += (await lstat(absolute)).size
        if (size > 100 * 1024 * 1024) throw Error('Plugin artifact exceeds inspection limit')
        const bytes = entry.isSymbolicLink() ? 'symlink:' + (await readlink(absolute)) : await readFile(absolute)
        hashes.set(path, createHash('sha256').update(bytes).digest('hex'))
      }
    }
    let checked = resolve(this.root)
    for (const part of [prepared.artifact, 'prepared', preparation, 'node_modules', prepared.packageName].flatMap(value => value.split('/'))) {
      checked = join(checked, part)
      const stat = await lstat(checked)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Invalid plugin artifact root')
    }
    await walk(root, '')
    return Object.fromEntries(hashes)
  }
}
