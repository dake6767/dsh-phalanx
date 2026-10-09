import { createReadStream } from 'node:fs'
import { lstat, realpath } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { PluginArchiveReadPort } from '../ports/plugin-market.js'
export class FilePluginArchiveSource implements PluginArchiveReadPort {
  constructor(private readonly dataRoot: string) {}
  async open(artifact: string) {
    if (!/^artifacts\/[a-f0-9]{128}$/u.test(artifact)) throw new Error('Invalid artifact')
    const root = resolve(this.dataRoot, 'plugins/artifacts')
    const path = resolve(this.dataRoot, 'plugins', artifact, 'original.tgz')
    const info = await lstat(path)
    if (!info.isFile() || !(await realpath(path)).startsWith(root + '/')) throw new Error('Invalid archive')
    return { size: info.size, body: (async function* () { const stream = createReadStream(path); try { yield* stream } finally { stream.destroy() } })() }
  }
}
