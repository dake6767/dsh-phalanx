import { assertPluginIdentity, PluginPreparationError } from '../domain/plugin-library.js'
import type { NpmPluginRequest } from '../domain/plugin-intake.js'
import type { DownloadSourceReaderPort } from '../ports/download-sources.js'
import type { NpmPluginSourcePort } from '../ports/plugin-source.js'

/** Read abbreviated registry metadata without invoking npm or package lifecycle scripts. */
export class HttpNpmPluginSource implements NpmPluginSourcePort {
  constructor(private readonly downloads: DownloadSourceReaderPort) {}
  async resolve(input: NpmPluginRequest, signal: AbortSignal) {
    try {
      const base = this.downloads.current().npm.replace(/\/+$/u, '')
      const response = await fetch(base + '/' + encodeURIComponent(input.packageName), {
        headers: { accept: 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8' },
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        redirect: 'error',
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new PluginPreparationError('plugin-registry-unavailable')
      }
      const reader = response.body?.getReader()
      if (!reader) throw new PluginPreparationError('plugin-registry-metadata-invalid')
      const chunks: Uint8Array[] = []
      let size = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.length
        if (size > 8 * 1024 * 1024) {
          await reader.cancel()
          throw new PluginPreparationError('plugin-registry-metadata-invalid')
        }
        chunks.push(value)
      }
      let metadata
      try {
        metadata = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid registry metadata')
      } catch (cause) {
        throw new PluginPreparationError('plugin-registry-metadata-invalid', { cause })
      }
      const version = input.version === 'latest' ? metadata['dist-tags']?.latest : input.version
      const manifest = metadata.versions?.[version]
      if (
        metadata.name !== input.packageName ||
        typeof version !== 'string' ||
        !manifest ||
        manifest.version !== version ||
        (manifest.name !== undefined && manifest.name !== input.packageName)
      )
        throw new PluginPreparationError('plugin-registry-metadata-invalid')
      const identity = { packageName: input.packageName, version }
      try {
        assertPluginIdentity(identity)
      } catch (cause) {
        throw new PluginPreparationError('plugin-registry-metadata-invalid', { cause })
      }
      return identity
    } catch (error) {
      if (error instanceof PluginPreparationError) throw error
      throw new PluginPreparationError(signal.aborted ? 'plugin-job-interrupted' : 'plugin-registry-unavailable', { cause: error })
    }
  }
}
