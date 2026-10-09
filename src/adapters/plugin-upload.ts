import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { BusinessRuleError } from '../domain/business-error.js'
import { assertPluginIdentity, PLUGIN_UPLOAD_MAX_BYTES, PluginPreparationError, type UploadedPlugin } from '../domain/plugin-library.js'
import type { PluginArchiveInspectorPort, PluginUploadPort } from '../ports/plugin-library.js'

/** Stream bytes only. Archive contents are read exclusively by the isolated inspector. */
export class FilePluginUpload implements PluginUploadPort {
  private cleanupFailed = false
  private readonly incoming: string
  private readonly archives: string
  constructor(dataRoot: string, private readonly inspector: PluginArchiveInspectorPort) {
    this.incoming = resolve(dataRoot, 'plugins/uploads/incoming')
    this.archives = resolve(dataRoot, 'plugins/uploads/archives')
  }
  async recover(retainedArchives: readonly string[]): Promise<void> {
    await rm(this.incoming, { recursive: true, force: true })
    const names = await readdir(this.archives).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return []; throw error })
    const retained = new Set(retainedArchives.map(archive => resolve(archive)))
    for (const name of names) {
      const archive = join(this.archives, name)
      if (!retained.has(archive)) await rm(archive, { recursive: true, force: true })
    }
    this.cleanupFailed = false
  }
  async accept(filename: string, content: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<UploadedPlugin> {
    if (this.cleanupFailed) throw new PluginPreparationError('plugin-cleanup-failed')
    if (!/^[^/\\]{1,240}\.tgz$/u.test(filename) || [...filename].some(character => character.charCodeAt(0) < 32)) throw new BusinessRuleError('invalid', 'Choose an npm pack .tgz archive.', 'plugin-upload-extension')
    signal.throwIfAborted()
    await mkdir(this.incoming, { recursive: true, mode: 0o700 }); await mkdir(this.archives, { recursive: true, mode: 0o700 })
    const id = `${randomUUID()}.tgz`
    const temporary = join(this.incoming, id)
    let preserve = false
    try {
      const file = await open(temporary, 'wx', 0o600)
      const hash = createHash('sha512'); let size = 0
      const iterator = content[Symbol.asyncIterator]()
      let cancel!: () => void
      const aborted = new Promise<never>((_, reject) => { cancel = () => reject(signal.reason ?? new Error('Upload cancelled')) })
      signal.addEventListener('abort', cancel, { once: true })
      try {
        signal.throwIfAborted()
        while (true) {
          const next = await Promise.race([iterator.next(), aborted])
          if (next.done) break
          const chunk = next.value
          signal.throwIfAborted(); size += chunk.byteLength
          if (size > PLUGIN_UPLOAD_MAX_BYTES) throw new BusinessRuleError('invalid', 'Plugin uploads must not exceed 50 MB.', 'plugin-upload-too-large')
          hash.update(chunk)
          let offset = 0
          while (offset < chunk.byteLength) offset += (await file.write(chunk, offset, chunk.byteLength - offset)).bytesWritten
        }
        signal.throwIfAborted()
        if (size === 0) throw new BusinessRuleError('invalid', 'Choose a nonempty npm pack archive.', 'plugin-package-invalid')
      } finally { signal.removeEventListener('abort', cancel); await file.close() }
      const identity = await this.inspector.inspect(temporary, signal)
      signal.throwIfAborted(); assertPluginIdentity(identity)
      const archive = join(this.archives, id)
      await rename(temporary, archive)
      return { ...identity, archive, integrity: `sha512-${hash.digest('base64')}` }
    } catch (error) {
      preserve = error instanceof PluginPreparationError && error.code === 'plugin-cleanup-failed'
      if (preserve) this.cleanupFailed = true
      if (signal.aborted && !preserve) throw new BusinessRuleError('invalid', 'The upload was interrupted.', 'plugin-upload-interrupted')
      throw error
    } finally { if (!preserve) await rm(temporary, { force: true }) }
  }
  async discard(archive: string): Promise<void> {
    if (!resolve(archive).startsWith(`${this.archives}/`)) throw new Error('Upload does not belong to this library')
    await rm(archive, { force: true })
  }
}
