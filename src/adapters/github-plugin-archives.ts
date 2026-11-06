import { createReadStream } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import type { UploadedPlugin } from '../domain/plugin-library.js'
import { PluginPreparationError, pluginSourceAbortCode } from '../domain/plugin-library.js'
import { BusinessRuleError } from '../domain/business-error.js'
import type { PluginUploadPort } from '../ports/plugin-library.js'
import type { GithubPluginArchivePort, GithubPluginRevision, GithubPluginSourcePort, PluginSourcePackerPort } from '../ports/plugin-source.js'

/** Download and packing use private staging; the packed archive then enters the upload store and its checks. */
export class GithubPluginArchives implements GithubPluginArchivePort {
  constructor(
    private readonly dataRoot: string,
    private readonly source: GithubPluginSourcePort,
    private readonly packer: PluginSourcePackerPort,
    private readonly uploads: PluginUploadPort,
  ) {}
  resolve(repository: string, signal: AbortSignal): Promise<GithubPluginRevision> {
    return this.source.resolve(repository, signal)
  }
  async pack(revision: GithubPluginRevision, signal: AbortSignal): Promise<UploadedPlugin> {
    const root = resolve(this.dataRoot, 'plugins', 'staging')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const staging = await mkdtemp(join(root, 'github-'))
    let retain = false
    try {
      const source = await this.source.download(revision, staging, signal)
      signal.throwIfAborted()
      const packed = await this.packer.pack(source, staging, signal)
      signal.throwIfAborted()
      const uploaded = await this.uploads.accept(basename(packed.archive), createReadStream(packed.archive), signal).catch((cause: unknown) => {
        // Size and archive rules of the upload store apply; as a precheck stage they become preparation failures.
        if (cause instanceof BusinessRuleError)
          throw new PluginPreparationError(signal.aborted ? pluginSourceAbortCode(signal, 'plugin-precheck-failed') : 'plugin-package-invalid', { cause })
        throw cause
      })
      if (uploaded.packageName !== packed.packageName || uploaded.version !== packed.version) {
        await this.uploads.discard(uploaded.archive)
        throw new PluginPreparationError('plugin-package-invalid')
      }
      return uploaded
    } catch (error) {
      // An unconfirmed container exit keeps its mounted files, as the cleanup failure message states.
      if (error instanceof PluginPreparationError && error.code === 'plugin-cleanup-failed') retain = true
      throw error
    } finally {
      if (!retain) await rm(staging, { recursive: true, force: true })
    }
  }
  discard(archive: string): Promise<void> {
    return this.uploads.discard(archive)
  }
}
